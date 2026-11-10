#!/bin/sh
# Type-check and lint the prototype with a host project's toolchain (TypeScript 7, oxlint type-aware).
set -e
cd "$(dirname "$0")"
A=/path/to/consumer-app
node "$A/node_modules/typescript-7/bin/tsc" --noEmit -p tsconfig.json
echo "tsc: 0 errors"
node "$A/node_modules/typescript-7/bin/tsc" --noEmit -p tsconfig.types.json
echo "tsc (type-level tests, with lib.dom): 0 errors"
PATH="$A/node_modules/.bin:$PATH" OXLINT_TSGOLINT_PATH="$A/node_modules/.bin/tsgolint" "$A/node_modules/.bin/oxlint" --type-aware --tsconfig tsconfig.json -c oxlintrc.json src bench test
echo "oxlint (type-aware): 0 findings"
