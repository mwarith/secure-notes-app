# **Product Requirements Document**

## **Secure Notes Application**

## **1\. Product Overview**

Build a secure, production-minded note-taking web application that allows users to create and manage private notes from a clean, responsive interface.

The project should demonstrate strong product engineering fundamentals including:

* Authentication  
* Authorization  
* Data privacy  
* Auditability  
* Note versioning  
* Autosave  
* Error handling  
* Logging  
* Metrics and monitoring  
* Automated testing  
* Browser automation  
* Performance testing  
* Operational resilience  
* Disciplined AI-assisted development  
* Structured ticket-to-code delivery

The application should remain simple from the user’s perspective while demonstrating production-quality engineering decisions behind the scenes.

The goal is not to build the largest possible application.

The goal is to build a small application with strong engineering discipline, clear trade-offs, and a reliable development workflow.

---

# **2\. Product Goals**

The product should allow a user to:

* Create an account securely.  
* Sign in using email and password.  
* Protect their account with two-factor authentication.  
* Create private notes.  
* Edit notes.  
* Delete notes.  
* Have changes saved automatically.  
* Understand whether changes are saving, saved, or have failed.  
* View previous versions of notes.  
* Restore previous versions.  
* Use the application confidently across common desktop and mobile screen sizes.

From an engineering perspective, the project should demonstrate:

* Secure authentication.  
* Strong authorization boundaries.  
* Data privacy between users.  
* Reliable application behaviour.  
* Useful auditability.  
* Graceful error handling.  
* Operational visibility.  
* Performance awareness.  
* Caching.  
* Automated quality checks.  
* End-to-end testing.  
* Reproducible local development.  
* Structured AI-assisted engineering.  
* Traceability between requirements, tickets, code, tests, and delivered features.

---

# **3\. Target User**

The primary user is an individual who wants a simple private workspace for storing notes.

Users expect:

* Their notes to remain private.  
* Their account to be protected.  
* Editing to feel immediate.  
* Changes not to be accidentally lost.  
* Previous content to be recoverable.  
* Errors to be understandable.  
* The application to remain responsive under normal usage.  
* Their security-sensitive activity to be handled safely.

---

# **4\. Core User Journey**

A new user should be able to:

1. Create an account using email and password.  
2. Sign in.  
3. Optionally enable two-factor authentication.  
4. Arrive at their notes workspace.  
5. Create a new note.  
6. Edit the note without manually saving every change.  
7. See whether the note is saving or saved.  
8. Leave and return later with the latest content preserved.  
9. View earlier versions of the note.  
10. Restore an earlier version if required.  
11. Delete a note.  
12. Sign out securely.

Returning users should be able to sign in quickly and continue where they left off.

Users with two-factor authentication enabled should complete an additional verification step before accessing their account.

---

# **5\. Authentication**

## **Account Creation**

Users must be able to register using:

* Email address  
* Password

The application should clearly communicate:

* Invalid inputs  
* Existing account conflicts  
* Password requirements  
* Successful account creation

## **Sign In**

Users should be able to authenticate using their email and password.

Unsuccessful authentication attempts should present safe and useful feedback without exposing sensitive account information.

## **Two-Factor Authentication**

Users should be able to enable time-based two-factor authentication compatible with commonly used authenticator applications, including Google Authenticator.

The setup flow should:

* Explain what two-factor authentication does.  
* Allow the user to connect their authenticator application.  
* Require verification before activation.  
* Provide recovery options.

Users should also be able to disable or reconfigure two-factor authentication after appropriate identity verification.

## **Recovery**

The application should provide a safe recovery mechanism for users who lose access to their authenticator device.

Recovery actions should be auditable.

## **Session Management**

The application should maintain secure authenticated sessions and prevent unauthorized access after logout or session expiry.

Sensitive session activity should be handled securely and should never be exposed in application logs.

---

# **6\. Notes**

## **Create Notes**

Users should be able to create a note containing:

* A title  
* Note content

A newly created note should become available immediately in the user’s notes workspace.

## **View Notes**

Users should see their notes in an easy-to-navigate workspace.

The interface should make it straightforward to:

* Browse existing notes.  
* Open a note.  
* Distinguish the currently selected note.  
* Create a new note.

## **Edit Notes**

Users should be able to modify both the title and content of their notes.

Editing should feel immediate and should not require a manual save action during normal use.

## **Autosave**

Changes should save automatically while the user works.

The interface should communicate the current state clearly, including:

* Saving  
* Saved  
* Save failed

Temporary connection or application failures should not silently discard user work.

The system should avoid excessive or meaningless saves while still protecting user changes.

Autosave failures should be visible to the user and observable by the engineering team.

## **Delete Notes**

Users should be able to delete their own notes.

Destructive actions should be clearly communicated and protected against accidental activation where appropriate.

A user must never be able to modify or delete another user’s notes.

---

# **7\. Note Version History**

The application should preserve meaningful historical versions of notes.

Users should be able to:

* Open the version history for a note.  
* See when previous versions were created.  
* Inspect earlier content.  
* Restore a previous version.

Restoring an older version should not erase the historical record.

Version history should focus on meaningful states rather than capturing every individual keystroke.

The application should avoid generating excessive versions from normal autosave behaviour.

Version history exists for content recovery and historical comparison.

It should remain separate from the audit log.

---

# **8\. Audit Log**

The system should maintain an audit trail for important user and security activity.

Relevant events include:

* Account creation  
* Successful sign-in  
* Failed sign-in  
* Sign-out  
* Two-factor authentication enabled  
* Two-factor authentication disabled  
* Recovery actions  
* Password-related security changes  
* Note creation  
* Note deletion  
* Note restoration  
* Version restoration  
* Relevant account or security changes

Audit information should answer:

* What happened?  
* When did it happen?  
* Which user performed the action?  
* What resource was affected?

Audit history is primarily an operational and security capability.

Audit logs should not contain sensitive secrets, passwords, tokens, or two-factor authentication secrets.

---

# **9\. Error Experience**

Errors should be handled deliberately rather than appearing as generic failures.

Users should receive clear feedback when:

* Authentication fails.  
* Two-factor verification fails.  
* A note cannot be saved.  
* Autosave fails.  
* A request times out.  
* A service is temporarily unavailable.  
* Invalid data is entered.  
* The user attempts an unauthorized action.  
* A note version cannot be restored.  
* A destructive action cannot be completed.

Where possible, the interface should allow the user to retry without losing their work.

Unexpected failures should be captured internally for investigation while presenting safe messaging to the user.

The application should distinguish between:

* User input errors  
* Authentication and authorization failures  
* Temporary operational failures  
* Unexpected internal errors

---

# **10\. Logging**

The application should produce useful structured operational logs.

Logs should make it possible to investigate:

* Failed requests  
* Unexpected exceptions  
* Slow operations  
* Authentication problems  
* Two-factor authentication failures  
* Save failures  
* Autosave failures  
* Version restoration failures  
* Database failures  
* Cache failures  
* Supporting service failures

Logs should allow activity related to a single request to be correlated during debugging.

Sensitive information must never appear in logs, including:

* Passwords  
* Session tokens  
* Authentication secrets  
* Two-factor authentication secrets  
* Recovery codes  
* Other sensitive credentials

Logs should support the project’s observability and debugging workflows.

---

# **11\. Metrics and Monitoring**

The application should expose enough operational information to understand its health and performance.

The monitoring experience should make it easy to observe:

* Request volume  
* Successful versus failed requests  
* Application errors  
* Response latency  
* Slow requests  
* Authentication failures  
* Two-factor authentication failures  
* Note creation activity  
* Note editing activity  
* Note deletion activity  
* Autosave failures  
* Version restoration activity  
* Data access performance  
* Cache effectiveness

Monitoring should help answer:

* Is the application healthy?  
* Is traffic increasing?  
* Are errors increasing?  
* Is latency degrading?  
* Are saves failing?  
* Is the cache helping?  
* Is the primary datastore becoming a bottleneck?

A monitoring dashboard should allow an interviewer or engineer to understand the current state of the application without inspecting application code.

---

# **12\. Performance and Stress Testing**

The project should include a repeatable Python-based stress-testing workflow.

Testing should simulate realistic application behaviour such as:

* User authentication  
* Viewing notes  
* Opening individual notes  
* Creating notes  
* Editing notes  
* Saving changes

The purpose is not simply to generate traffic.

The performance-testing workflow should help answer:

* How does latency change as traffic grows?  
* At what point do errors begin increasing?  
* Which operations become slow first?  
* Does caching improve performance?  
* Does the application recover once load is removed?  
* Which part of the system becomes the bottleneck?

Performance findings should be easy to demonstrate and explain during an interview.

Where useful, performance results should be correlated with application metrics and logs.

---

# **13\. Automated Unit and Integration Testing**

Important business behaviour should be covered by automated tests.

High-value areas include:

* Authentication rules  
* Authorization  
* Note ownership  
* Two-factor authentication behaviour  
* Input validation  
* Note creation  
* Note editing  
* Autosave behaviour  
* Version creation  
* Version restoration  
* Audit event creation  
* Error handling  
* Cache behaviour  
* Cache invalidation  
* Security-sensitive business rules

Tests should focus on meaningful product behaviour rather than implementation details.

A feature should not be considered complete until its relevant automated tests pass.

---

# **14\. Browser Automation**

The application should include automated browser-level tests representing important real user journeys.

Coverage should include:

* Account registration  
* Login  
* Login failure  
* Two-factor authentication setup  
* Two-factor authentication login  
* Creating a note  
* Editing a note  
* Autosave  
* Refreshing and confirming saved content remains  
* Version history  
* Restoring a version  
* Deleting a note  
* Logging out  
* Preventing unauthorized access  
* Key application error states

Browser tests should act as a final verification that major product journeys work from a user’s perspective.

User-facing functionality should not rely solely on unit tests for confidence.

---

# **15\. Security Expectations**

Security is a core product requirement.

The application should ensure:

* Users can access only their own information.  
* Authentication credentials are protected.  
* Two-factor authentication secrets are protected.  
* Sessions are securely managed.  
* Recovery information is protected.  
* Repeated authentication abuse can be controlled.  
* Sensitive information is excluded from logs.  
* User input is validated.  
* Destructive actions are protected appropriately.  
* Important security actions are auditable.

Security decisions should be explainable during the interview.

Security should be considered during feature design rather than treated as a final cleanup task.

---

# **16\. User Interface Expectations**

The interface should be intentionally simple.

Core areas should include:

* Registration  
* Login  
* Two-factor authentication  
* Notes workspace  
* Note editor  
* Version history  
* Security settings

The product should provide clear feedback for:

* Loading  
* Empty states  
* Saving  
* Saved  
* Success  
* Errors  
* Destructive actions

The interface should prioritize:

* Accessibility  
* Clarity  
* Responsive behaviour  
* Predictable interactions  
* Good keyboard usability  
* Consistent forms  
* Safe destructive actions

The design should prioritize usability and clarity rather than demonstrating as many interface components as possible.

---

# **17\. Reliability Expectations**

The application should remain usable when non-critical supporting systems experience temporary problems.

A failure in an optimization, logging, or monitoring capability should not unnecessarily make the core note-taking experience unavailable.

Where appropriate, the system should degrade gracefully.

The application should expose enough information to diagnose underlying problems.

Supporting services should not become unnecessary single points of failure for core user data.

---

# **18\. High-Level Technology Stack**

The application should use a modern, production-oriented full-stack web architecture while remaining simple enough to run locally and demonstrate during an interview.

## **Application**

The product should be built as a full-stack Next.js application.

Next.js should provide the primary application runtime for:

* User-facing pages  
* Authentication flows  
* Notes functionality  
* Server-side application behaviour  
* API endpoints  
* Operational endpoints

The project should use the latest stable supported release of Next.js available when development begins.

Preview, beta, canary, nightly, or otherwise experimental releases should not be used unless explicitly required.

## **Language**

The primary application language should be TypeScript.

## **User Interface**

The interface should use React with shadcn/ui.

The UI should remain accessible, responsive, consistent, and product-focused.

## **Primary Database**

PostgreSQL should be used as the application’s primary persistent datastore.

It should hold durable product data including:

* Users  
* Notes  
* Note versions  
* Authentication-related records  
* Audit events  
* Other persistent application state

The project should use the latest stable major version of PostgreSQL available when development begins, including the latest applicable stable patch release.

Development releases, beta releases, and release candidates should not be used.

## **Cache and Fast Data Store**

Valkey should be used as the application’s in-memory datastore.

Valkey replaces Redis as the cache requirement for this project.

It may support appropriate use cases such as:

* Application caching  
* Temporary authentication state  
* Session-related state  
* Rate-limiting information  
* Other short-lived application data

Valkey should remain an optimization or supporting service wherever practical.

Failure of the caching layer should not unnecessarily make durable application data unavailable.

The project should use the latest stable supported release of Valkey available when development begins.

## **Observability**

Grafana should provide the primary operational dashboard experience.

The monitoring stack should allow engineers to understand:

* Request traffic  
* Request latency  
* Error rates  
* Application health  
* Database performance  
* Cache effectiveness  
* Authentication failures  
* Autosave failures

Supporting observability components may be included where required to provide metrics and logs to Grafana.

The project should use the latest stable supported Grafana release available when development begins.

Nightly or preview releases should not be used for the primary environment.

## **Logging**

The application should produce structured logs suitable for troubleshooting and operational analysis.

Logs should be accessible through the project’s observability workflow.

## **Automated Testing**

The project should include:

* Unit testing  
* Integration testing  
* Browser automation

Automated tests should form part of the definition of done for implementation work.

## **Performance Testing**

A Python-based stress-testing workflow should be included.

It should generate realistic application traffic and support investigation of:

* Throughput  
* Latency  
* Failure rates  
* Bottlenecks  
* Cache behaviour  
* Recovery after load

## **Local Orchestration**

Docker Compose should be the standard way to start the complete local application environment.

A developer should be able to start the application and required supporting services through a small number of documented commands.

The Docker Compose environment should include the services required for the complete system, including:

* Web application  
* PostgreSQL  
* Valkey  
* Grafana  
* Required monitoring services  
* Required logging services

The goal is to make local development and interview demonstration reproducible.

---

# **19\. Dependency Version Policy**

The project should use the latest stable supported version of major dependencies available when development begins.

Container images and dependencies should not rely on floating latest tags.

At project initialization:

1. Determine the latest stable supported release of each major dependency.  
2. Pin the selected version explicitly.  
3. Record the selected versions in project documentation.  
4. Update versions intentionally through dedicated dependency-update tickets.

This applies in particular to:

* Next.js  
* PostgreSQL  
* Valkey  
* Grafana  
* Monitoring infrastructure  
* Logging infrastructure  
* Testing infrastructure

Dependency upgrades should be deliberate rather than occurring unexpectedly when containers are rebuilt.

---

# **20\. High-Level Stack Summary**

The intended stack is:

**Application:** Next.js

**Language:** TypeScript

**UI:** React with shadcn/ui

**Primary database:** PostgreSQL

**Caching and fast data:** Valkey

**Observability:** Grafana-based monitoring, metrics, and logging workflow

**Local orchestration:** Docker Compose

**Performance testing:** Python

**Automated application testing:** Unit, integration, and browser automation

**Task management:** Linear

**Source control:** Git

**Branching model:** One branch per Linear ticket

**AI coding agent:** OpenCode

**AI coding model:** DeepSeek Flash or the selected current equivalent configured for the project

**AI engineering workflow:** Matt Pocock’s engineering skills and practices

---

# **21\. Local Development Experience**

The local environment should closely represent the complete system without attempting to reproduce unnecessary production infrastructure.

The project should favour:

* Reproducibility  
* Explicit versions  
* Simple startup  
* Observable behaviour  
* Easy reset and recovery  
* Clear documentation

A new developer should be able to:

1. Clone the project.  
2. Configure required environment values.  
3. Start the complete Docker Compose environment.  
4. Access the application.  
5. Access monitoring.  
6. Run automated tests.  
7. Run browser automation.  
8. Run stress tests.

The project should not depend on undocumented manual setup.

---

# **22\. AI-Assisted Development Workflow**

AI should be used as a disciplined engineering assistant rather than an autonomous replacement for engineering judgement.

The project will use OpenCode together with the workflow and engineering skills published in Matt Pocock’s mattpocock/skills repository.

Repository:

[https://github.com/mattpocock/skills](https://github.com/mattpocock/skills)

The development process should adopt the following principles.

## **Align Before Building**

For meaningful changes, the coding agent should first help clarify:

* The user problem  
* Expected behaviour  
* Edge cases  
* Acceptance criteria  
* Constraints  
* Relevant existing behaviour

The goal is to reduce the chance of implementing the wrong solution.

## **Maintain Shared Project Language**

Important domain concepts and project terminology should be documented consistently.

Examples include:

* Note  
* Note version  
* Autosave  
* Audit event  
* Authenticated session  
* Two-factor challenge

The AI coding agent should use the same terminology in:

* Tickets  
* Discussion  
* Code  
* Tests  
* Documentation

## **Work in Small Changes**

Large features should be divided into small, reviewable units.

Each unit should have:

* A clear expected outcome  
* Defined acceptance criteria  
* A feedback loop  
* Relevant tests

The project should avoid asking the coding agent to independently implement large sections without intermediate validation.

## **Test-Driven Development**

For suitable business logic and bug fixes, use a red-green-refactor workflow:

1. Define expected behaviour.  
2. Establish a failing test.  
3. Implement the minimum change required.  
4. Confirm the test passes.  
5. Refactor where appropriate.  
6. Run the wider test suite.

## **Browser Feedback**

For user-facing changes, the AI workflow should use the running application and browser-level feedback rather than relying exclusively on static code inspection.

## **Structured Debugging**

When a defect appears:

1. Reproduce the problem.  
2. Gather evidence.  
3. Identify the failing layer.  
4. Form a specific hypothesis.  
5. Test the hypothesis.  
6. Make the smallest appropriate fix.  
7. Add regression coverage.

The coding agent should avoid speculative multi-change fixes.

## **Human Ownership**

The developer remains responsible for:

* Architecture  
* Product scope  
* Security decisions  
* Reviewing generated code  
* Accepting trade-offs  
* Determining when implementation is complete

AI-generated changes should be reviewed and validated in the same way as human-written changes.

---

# **23\. Engineering Delivery Workflow**

Development work should be managed through a consistent ticket-to-code workflow using Linear, OpenCode, and Git.

## **Linear as the Source of Work**

Every meaningful piece of implementation work must have a corresponding Linear ticket before development begins.

Tickets should cover work such as:

* Product features  
* Bugs  
* Refactoring  
* Testing  
* Observability improvements  
* Security improvements  
* Performance work  
* Infrastructure changes  
* Dependency upgrades

Each ticket should clearly describe:

* The problem or desired outcome  
* Scope  
* Acceptance criteria  
* Relevant edge cases  
* Testing expectations

Large pieces of work should be broken into smaller, independently reviewable tickets.

## **Linear and OpenCode Integration**

OpenCode should be connected to the Linear development workflow so that the coding agent works from an explicit ticket rather than an unstructured prompt.

The intended flow is:

**Linear ticket → OpenCode task context → Git branch → implementation → tests → review → ticket completion**

The AI coding agent should:

* Understand the relevant ticket before making changes.  
* Use the ticket’s acceptance criteria to determine expected behaviour.  
* Keep changes within the ticket’s agreed scope.  
* Reference the ticket while implementing and testing work.  
* Surface ambiguities rather than silently expanding scope.  
* Validate the completed implementation against ticket acceptance criteria.

## **One Task, One Ticket**

Every meaningful implementation task should have a Linear ticket.

Work should not normally be performed as unnamed or untracked development.

Small discoveries made during development should either:

* Be addressed within the existing ticket when clearly within scope, or  
* Become a new Linear ticket when they represent separate work.

This provides traceability between product requirements, implementation decisions, and completed code.

## **One Ticket, One Git Branch**

Each Linear ticket should normally have its own Git branch.

The branch should be associated with the ticket and use a predictable naming convention.

Examples:

ENG-42-note-version-history

ENG-57-fix-autosave-retry

This should make it immediately clear:

* Which ticket a branch belongs to.  
* Why the code change exists.  
* Which work is currently in progress.

Multiple unrelated tickets should not be combined into a single branch.

## **Commit and Pull Request Traceability**

Commits and pull requests should reference the relevant Linear ticket.

A reviewer should be able to move easily between:

**Requirement → Linear ticket → Git branch → commits → pull request → tests**

The pull request should explain:

* What changed  
* Why it changed  
* Which ticket it satisfies  
* How the change was tested  
* Any important trade-offs  
* Any follow-up work

---

# **24\. Definition of Ready**

A ticket is ready for implementation when:

* The desired outcome is understood.  
* Acceptance criteria are defined.  
* Dependencies are known.  
* Important edge cases have been considered.  
* Testing expectations are understood.  
* The task is small enough to implement and review confidently.

OpenCode should not be used to compensate for an unclear task definition.

Clarifying the ticket is part of the engineering process.

---

# **25\. Definition of Done**

A Linear ticket should only be considered complete when:

* The acceptance criteria are satisfied.  
* The implementation is complete.  
* Relevant unit tests pass.  
* Relevant integration tests pass.  
* Relevant browser automation tests pass.  
* Error states have been considered.  
* Logging requirements have been addressed where relevant.  
* Metrics requirements have been addressed where relevant.  
* Audit requirements have been addressed where relevant.  
* Security implications have been considered.  
* The implementation has been reviewed.  
* The associated code has been merged.  
* Any discovered follow-up work has been captured as separate tickets.

---

# **26\. AI-Assisted Ticket Workflow**

For each Linear task, the preferred OpenCode workflow is:

1. Read the Linear ticket.  
2. Clarify the expected outcome.  
3. Review acceptance criteria.  
4. Inspect relevant existing behaviour.  
5. Create or switch to the ticket’s Git branch.  
6. Establish tests or expected feedback before significant implementation.  
7. Implement the smallest coherent change.  
8. Run relevant unit and integration tests.  
9. Exercise user-facing behaviour through browser automation where applicable.  
10. Review the resulting changes against the original ticket.  
11. Fix regressions or incomplete acceptance criteria.  
12. Review logs, errors, metrics, and audit implications where relevant.  
13. Prepare the change for code review.  
14. Merge the work.  
15. Complete the Linear ticket.

This workflow should follow the broader Matt Pocock engineering principles used by the project:

* Align before coding  
* Maintain shared language  
* Work in small increments  
* Use strong feedback loops  
* Test deliberately  
* Debug from evidence  
* Keep human ownership of engineering decisions

---

# **27\. Workflow Success Criteria**

The development process should demonstrate that:

* Every meaningful task can be traced to a Linear ticket.  
* Every active implementation ticket has a corresponding Git branch.  
* OpenCode operates from structured task context.  
* Pull requests reference the work they implement.  
* Tests map back to acceptance criteria.  
* Scope changes are visible rather than silently introduced.  
* Completed tickets accurately reflect shipped behaviour.  
* AI-generated code remains part of a human-reviewed engineering workflow.

---

# **28\. Demonstration Scenario**

A strong interview demonstration should show the product as a complete system.

Suggested flow:

1. Start the complete environment through Docker Compose.  
2. Register a new account.  
3. Sign in.  
4. Enable two-factor authentication.  
5. Sign out.  
6. Sign back in using two-factor authentication.  
7. Create a note.  
8. Edit the note.  
9. Demonstrate autosave.  
10. Refresh the application and confirm the changes remain.  
11. Make another substantial edit.  
12. Open version history.  
13. Restore an earlier version.  
14. Show the corresponding audit activity.  
15. Delete a note.  
16. Generate application traffic using the stress-testing workflow.  
17. Show monitoring dashboards reacting to the traffic.  
18. Demonstrate request traffic, latency, and error visibility.  
19. Show cache effectiveness.  
20. Run automated unit tests.  
21. Run browser automation.  
22. Show a Linear ticket associated with the demonstrated work.  
23. Show the corresponding Git branch and pull request.  
24. Explain how OpenCode was used within the ticket-driven workflow.  
25. Explain one performance, reliability, or security trade-off discovered during development.

---

# **29\. Success Criteria**

The project is considered complete when:

* Users can register.  
* Users can authenticate securely.  
* Two-factor authentication works.  
* Users can create notes.  
* Users can read notes.  
* Users can edit notes.  
* Users can delete notes.  
* Users cannot access another user’s notes.  
* Editing supports reliable autosave.  
* Autosave state is visible.  
* Notes have meaningful version history.  
* Previous versions can be restored.  
* Important actions generate audit events.  
* User-facing errors are handled clearly.  
* Operational failures produce useful logs.  
* Application health and performance are visible through monitoring.  
* Stress tests can generate repeatable load.  
* Cache behaviour can be observed.  
* Important business logic has automated tests.  
* Critical user journeys have automated browser tests.  
* Docker Compose starts the complete local environment.  
* Major dependencies use explicit stable versions.  
* Every meaningful implementation task has a Linear ticket.  
* Every implementation ticket has an associated Git branch.  
* Pull requests are traceable to tickets.  
* OpenCode operates from structured task context.  
* The AI-assisted workflow follows disciplined engineering practices.  
* The complete application can be demonstrated reliably.

---

# **30\. Out of Scope**

Unless additional time remains, the first version does not need:

* Team collaboration  
* Shared notes  
* Real-time multi-user editing  
* Rich document formatting  
* File attachments  
* Native mobile applications  
* Social login  
* Public note sharing  
* Complex role-based permissions  
* Enterprise administration  
* AI-generated note content  
* Multi-region deployment  
* Production Kubernetes infrastructure  
* Complex distributed-service architecture

These may be discussed as future extensions without increasing the initial implementation scope.

---

# **31\. Interview Evaluation Themes**

The project should give the candidate opportunities to discuss:

* Product trade-offs  
* Authentication  
* Two-factor authentication  
* Security  
* Authorization boundaries  
* Data integrity  
* Autosave design  
* Version history  
* Auditability  
* Error recovery  
* Structured logging  
* Metrics  
* Observability  
* Performance  
* Caching  
* Stress testing  
* Testing strategy  
* Browser automation  
* Dependency management  
* Docker Compose  
* Local reproducibility  
* AI-assisted engineering  
* Ticket-driven development  
* Git workflow  
* Debugging methodology  
* Scope management  
* Production readiness

The final application should demonstrate a small but credible production system built with strong engineering discipline.

