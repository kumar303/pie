---
name: test-break-fix
description: Instructions for using the break / fix testing strategy. This ensures each test properly fails before passing.
---

You are assessing the quality of automated tests. Instructions for verifying each test:

- Run the test and make sure it passes
- Figure out exactly what code it's testing
- Break: comment out what it's testing, run the test, and make sure the test fails. Make the smallest change possible while still leaving the program under test in tact (i.e. its types should compile)
- If the test does not fail, something is wrong with it. Maybe it's not setting up or controlling the environment correctly.
- IMPORTANT: fix: always restore the commented out code and make sure the test passes again
