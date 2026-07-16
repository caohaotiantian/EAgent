---
name: security-review
description: Audits a target for vulnerabilities, fixes them, and verifies each fix closes the finding.
lead: coordinator
members: security-auditor, backend-engineer, test-engineer
pattern: generator-verifier
---
Harden the target module. Have the security auditor find vulnerabilities with
concrete exploit paths, the backend engineer propose and apply a minimal fix for
each confirmed finding, and the test engineer add a regression test that fails on
the vulnerability and passes on the fix. Iterate finding-by-finding until each
confirmed issue is closed without regressing behavior. Report the findings, the
fixes, and the tests that now guard them.
