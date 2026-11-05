# Third-party components

## Xray-core

- Project: https://github.com/XTLS/Xray-core
- Version: release 26.10.31
- Go module pseudo-version: `v1.260327.1-0.20261031132019-a4a3dff5b20c`
- License: Mozilla Public License 2.0 (MPL-2.0)
- Text: https://www.mozilla.org/en-US/MPL/2.0/

The helper statically links xray-core. No modifications are made to xray-core
sources; the dependency is fetched from the official module proxy/repository
at build time. If you redistribute the helper binary, keep this notice and
comply with MPL-2.0 (source availability for xray-core).

## Other Go dependencies

`github.com/gofrs/flock` (BSD-3-Clause) and the transitive dependencies of
xray-core. Their licenses are available in the Go module cache and in the
corresponding upstream repositories.
