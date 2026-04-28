default:
    @just --list

release:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Preparing to release @bodhiapp/llm-liberty..."
    node scripts/git-check-branch.mjs
    node scripts/git-check-clean.mjs
    node scripts/git-check-pushed.mjs
    CURRENT_VERSION=$(node scripts/get-npm-version.mjs @bodhiapp/llm-liberty)
    NEXT_VERSION=$(node scripts/increment-version.mjs "$CURRENT_VERSION")
    echo "Current version on npmjs: $CURRENT_VERSION"
    echo "Next version to release: $NEXT_VERSION"
    TAG_NAME="v$NEXT_VERSION"
    node scripts/delete-tag-if-exists.mjs "$TAG_NAME"
    echo "Creating tag $TAG_NAME..."
    git tag "$TAG_NAME"
    git push origin "$TAG_NAME"
    echo "Tag $TAG_NAME pushed. GitHub workflow will publish."
