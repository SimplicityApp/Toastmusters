#!/bin/sh
# gh for this repo. Locally, GITHUB_TOKEN may hold a work account that can read this public repo
# but not write to it; drop it so gh uses the keyring login. In CI the token is the right one.
[ -z "$CI" ] && unset GITHUB_TOKEN
exec gh "$@"
