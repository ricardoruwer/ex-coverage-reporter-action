#!/usr/bin/env node
/**
 * Reads mix test --cover output from coverage_report.log, builds a PR comment
 * with truncated coverage table to stay under GitHub's 65536-char limit,
 * and posts/updates the comment via GitHub API.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, ISSUE_NUMBER, COVERAGE_THRESHOLD (default 80)
 */

const fs = require("fs");
const https = require("https");

const MAX_BODY_CHARS = 65_000;
const COVERAGE_TABLE_HEADER = "Percentage | Module";

const NOISE_LINE_PATTERNS = [
  /^Analysis includes data from imported files$/,
  /\.coverdata/,
  /^Generated HTML coverage results in /,
  /^Coverage test failed, threshold not met/,
  /^\s*Coverage:\s+[\d.]+%\s*$/,
  /^\s*Threshold:\s+[\d.]+%\s*$/,
];

function stripCoverageTableNoise(table) {
  return table
    .split("\n")
    .filter((line) => !NOISE_LINE_PATTERNS.some((re) => re.test(line.trim())))
    .join("\n")
    .trim();
}

function parseCoverageLog(content) {
  const failuresMatch = content.match(/(\d+) failure[s]?/);
  const totalFailures = failuresMatch ? parseInt(failuresMatch[1], 10) : 0;

  const totalPctMatch = content.match(/\s+(\d+\.\d+)%\s+\|\s+Total/);
  const totalCoverage = totalPctMatch ? parseFloat(totalPctMatch[1]) : 0;

  const tableStart = content.indexOf(COVERAGE_TABLE_HEADER);
  if (tableStart === -1) return null;
  const rawTable = content.slice(tableStart).trim();
  const coverageTable = stripCoverageTableNoise(rawTable);

  const summaryMatch = content.match(/Finished in [^\n]+/);
  const summary = summaryMatch ? summaryMatch[0] : "";

  const seedMatch = content.match(
    /Running ExUnit with seed: \d+, max_cases: \d+/,
  );
  const randomizedSeed = seedMatch ? seedMatch[0] : "";

  const testsMatch = content.match(/(\d+) test[s]?/);
  const tests = testsMatch && testsMatch[1] ? testsMatch[1] : "?";

  return {
    summary,
    randomizedSeed,
    tests,
    totalFailures,
    totalCoverage,
    coverageTable,
  };
}

function buildComment(data, coverageThreshold) {
  const testsSuccess = data.totalFailures === 0;
  const coverageSuccess = data.totalCoverage >= coverageThreshold;
  const status = (ok) => (ok ? ":white_check_mark:" : ":x:");

  let body = `### Tests summary

${data.summary}
${data.randomizedSeed}

${status(testsSuccess)} **${data.totalFailures} failures** (${data.tests} tests)
${status(coverageSuccess)} **${data.totalCoverage}% coverage** (${coverageThreshold}% minimum)

<details>
<summary>Coverage details</summary>

\`\`\`
${data.coverageTable}
\`\`\`
</details>
`;

  if (body.length > MAX_BODY_CHARS) {
    const headerLength = body.indexOf("```") + 3 + "\n".length;
    const footerLength = body.length - body.lastIndexOf("```") + 20;
    const maxTable = MAX_BODY_CHARS - headerLength - footerLength;
    const truncated =
      data.coverageTable.slice(0, maxTable) +
      "\n... (truncated — run mix test --cover locally for full report)";
    body = `### Tests summary

${data.summary}
${data.randomizedSeed}

${status(testsSuccess)} **${data.totalFailures} failures** (${data.tests} tests)
${status(coverageSuccess)} **${data.totalCoverage}% coverage** (${coverageThreshold}% minimum)

<details>
<summary>Coverage details</summary>

\`\`\`
${truncated}
\`\`\`
</details>
`;
  }

  return { body, testsSuccess, coverageSuccess };
}

function ghRequest(method, path, body, token) {
  const url = new URL(path, "https://api.github.com");
  const opts = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ex-coverage-reporter-comment",
    },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400)
            reject(
              new Error(
                `GitHub API ${res.statusCode}: ${json.message || data}`,
              ),
            );
          else resolve(json);
        } catch (e) {
          reject(new Error(`Parse response: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const threshold = parseInt(process.env.COVERAGE_THRESHOLD || "80", 10);

  if (!token || !repo || !issueNumber) {
    console.error("Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or ISSUE_NUMBER");
    process.exit(1);
  }

  const logPath = process.argv[2] || "coverage_report.log";
  if (!fs.existsSync(logPath)) {
    console.error("Coverage log not found:", logPath);
    process.exit(1);
  }

  const content = fs.readFileSync(logPath, "utf8");
  const data = parseCoverageLog(content);
  if (!data) {
    console.error("Could not parse coverage report");
    process.exit(1);
  }

  const { body, testsSuccess, coverageSuccess } = buildComment(data, threshold);

  const [owner, repoName] = repo.split("/");

  const comments = await ghRequest(
    "GET",
    `/repos/${owner}/${repoName}/issues/${issueNumber}/comments`,
    null,
    token,
  );

  const existing = Array.isArray(comments)
    ? comments.find((c) => c.body && c.body.includes("### Tests summary"))
    : null;

  if (existing) {
    await ghRequest(
      "PATCH",
      `/repos/${owner}/${repoName}/issues/comments/${existing.id}`,
      JSON.stringify({ body }),
      token,
    );
    console.log("Updated coverage comment");
  } else {
    await ghRequest(
      "POST",
      `/repos/${owner}/${repoName}/issues/${issueNumber}/comments`,
      JSON.stringify({ body }),
      token,
    );
    console.log("Created coverage comment");
  }

  if (!testsSuccess || !coverageSuccess) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
