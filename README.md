# ex-coverage-reporter-action

GitHub Action that runs `mix test --cover` in Elixir projects and posts a coverage summary as a comment on the PR.

## Usage

In your repo's workflow (e.g. `.github/workflows/ci.yml`), add a job that uses [setup-beam](https://github.com/erlef/setup-beam) and this action:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: erlef/setup-beam@v1
        with:
          elixir-version: '1.15.0'
          otp-version: '26.0'

      - name: Run tests & coverage
        uses: ricardoruwer/ex-coverage-reporter-action@v1
        with:
          github-token: ${{ github.token }}
          coverage-threshold: 80
```

On pull requests, the action will run `mix test --cover`, parse the output, and post or update a single comment with the test summary and coverage table. The job fails if tests fail or coverage is below the threshold.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | Yes | - | Token for GitHub API (use `${{ github.token }}`) |
| `coverage-threshold` | No | `80` | Minimum coverage percentage |
| `issue-number` | No | from event | PR/issue number for the comment (auto-detected on `pull_request` events) |

## Requirements

- Elixir/Erlang must be set up in the job before this step (e.g. with `erlef/setup-beam`).
- The project must support `mix test --cover` and produce a coverage table in the output (e.g. ExUnit with coverage configured).

## Threshold behavior

The **action’s** `coverage-threshold` is what decides whether the CI step fails. If your project has a different threshold in `mix.exs` (e.g. `test_coverage: [threshold: 90]`), `mix test --cover` may exit with code 3 when that project threshold isn’t met. This action treats that exit code as non-fatal and still posts the comment; it only fails the job when coverage is below the threshold you set in the action (e.g. 80%). So you can use a lower (or higher) threshold in the action than in the project.

## Publishing

1. Create a git tag (e.g. `v1`) and push it.
2. Other repos can pin with `ricardoruwer/ex-coverage-reporter-action@v1` or `@main` for the latest.
