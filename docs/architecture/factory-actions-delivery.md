# GitHub Actions delivery

Factory managers can submit a guarded delivery command for one GitHub Actions workflow. Use an approved M06 deployment source with provider `github-actions`, the decimal GitHub workflow ID as its project ID, and the intended environment. GitHub remains responsible for workflow permissions and environment protections.

## Configure a workflow

- Install the Wallie GitHub App on the repository. Grant **Actions write** and **Contents read**. Dispatch mints a fresh credential scoped to that numeric repository. Observation uses Actions read.
- Put the workflow file on the default branch. The exact immutable release commit must contain the same workflow path and declare the `workflow_dispatch` contract below.
- Publish an [immutable release](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) whose tag resolves to the session's canonical merged SHA. Wallie verifies GitHub's immutable release record and tag before dispatch.
- Declare the Wallie inputs as required strings. Its first run title must be unique to the command. Pass the inputs to steps through environment variables and check the source SHA before deployment.

```yaml
run-name: wallie:${{ inputs.wallie_run_nonce }}
on:
  workflow_dispatch:
    inputs:
      wallie_command_id:
        required: true
        type: string
      wallie_source_sha:
        required: true
        type: string
      wallie_environment:
        required: true
        type: string
      wallie_run_nonce:
        required: true
        type: string
```

## Deliver approved source

Resolve the guarded delivery candidate and POST `action: "prepare"` to its [delivery command endpoint](factory-delivery-commands.md). Alongside the candidate's exact evidence IDs, supply `actions.workflowId`, `actions.workflowPath`, `actions.tag`, and `actions.inputs`. The tag omits the `refs/tags/` prefix. Use only nonsecret strings for custom workflow inputs. The command keeps that target for retries and reads.

The worker retains the provider run ID and checks its workflow, ref, actor, commit, first attempt, and private run title. An unknown POST response triggers a bounded read-only search for the original run. The command's deployment outcome comes from the authenticated M06 reporter for the same repository, workflow, environment, SHA, and command UUID. Keep reporting credentials separate from workflow inputs.

## Recover a command

| Command or Actions receipt                             | Operator action                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `blocked` or `permission_missing`                      | Restore repository connection or Actions permission. Confirm the exact source and prepare a new command.                                |
| `workflow_unavailable` or `workflow_contract_mismatch` | Check the active workflow ID and the committed workflow file. Approve the corrected source and publish its immutable tag.               |
| `immutable_tag_required` or `source_mismatch`          | Compare the selected immutable tag to the candidate's merged SHA.                                                                       |
| `rejected`                                             | Check the Actions reason and confirm the workflow configuration before preparing a new command.                                         |
| `unknown`, `run_mismatch`, or `observation_expired`    | Inspect the original workflow's run history and the deployment provider. Submit the exact authenticated M06 observation when available. |
| `run_verified` with pending outcome                    | Inspect the linked run by ID and wait for the deployment reporter.                                                                      |

Unknown requests remain protected from redispatch. The read-only reconciliation window is 30 minutes. An Actions conclusion supplies the workflow result. The M06 receipt supplies deployment success or failure.

## Isolated GitHub qualification

The effectless fixture checks its tag, exact source SHA, command ID, and fixture environment. It runs without a repository checkout or write permissions.

A smoke-test tag used the same fixture at an existing registered workflow path. GitHub accepted the dispatch. The fixture transport discarded the response, then the adapter found one run by its exact tag, SHA, workflow ID, actor, and correlation nonce. The job emitted the expected command ID and source SHA. [GitHub Actions evidence](https://github.com/anantjain-xyz/wallie-dev/actions/runs/45263916505)

The smoke test used fixture-injected repository credentials and immutable-release metadata. The separate App authentication and database tests cover denied or revoked installation access, rejected refs, and the requirement for a current M06 receipt before deployment can succeed.
