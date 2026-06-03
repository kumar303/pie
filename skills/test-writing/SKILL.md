---
name: test-writing
description: Guidelines for writing high quality automated tests. Use this skill whenever you write a test.
---

## General guidelines

- Use TDD (test driven development) at all times with some exceptions noted below
- Prefer integration-style tests that exercise behavior through public interfaces.
- Simulate user input in a realistic manner
- Test observable behavior, not implementation details.
- Keep each test focused on one behavior.
- Name tests by the behavior they verify.

## Gotchas

- Never test static configuration. If the code does not have any dynamism (e.g. variables or user inputs) then it does not need to be tested.
- Never change an existing test unless you are sure the behavior has changed

## Setup / teardown

- Setup must be atomic: you must guarantee it will be torn down no matter how the test or code under test fails during the test run
- Add explicit setup. Never rely on default setup parameters when they affect the behavior under test.
- Create factory helpers for common setup routines
- Always search for and use existing helpers
- Only create helpers for complex setup. Avoid excessive indirection. Prefer readable test setup over obfuscated helpers.
- IMPORTANT: test setup must never leak from one test to another

## Assertions

- Match the smallest output that proves the behavior was successful. Avoid matching large blocks of text or layout or whitespace that will need to be updated frequently.
- Every assertion failure must provide enough information for an agent to diagnose and correct the failure
- Do not simply assert truthiness. Assert on specific values.

## Mock objects

- Only use mock objects as a last resort to speed up the test suite or avoid side effects
- Mock only external boundaries or expensive/non-deterministic dependencies.
- IMPORTANT: keep all mock objects in sync with real objects by implementing a shared type between the real and mocked interface.

## Dependency injection

- Avoid changing public interfaces just for testing purposes
- Rely on built-in mechanisms for top-level dependency injection such as mocking package imports

## Refactoring

- When you're refactoring, i.e. changing the implementation without changing the public interface, don't use TDD.
- Do a thorough analysis of what tests to run before the refactor
- Run the tests after every refactoring change

## Avoid flaky tests

- Think of ways the test might fail on other machines or in different environments. Control the environment.
- Avoid real time by using mocked or fake timers
- Test async operations either by controlling resolution directly or, as a last resort, by implementing a wait-loop that polls until a condition is met.
- IMPORTANT: never sleep arbitrarily to wait for an async operation
- Be careful with testing time based code. Think about midnight crossings and other times of day the test might fail.
- Make sure the test or code under test doesn't access shared global state that could be altered during the test run
- control all environment variables that the code under test might rely on
