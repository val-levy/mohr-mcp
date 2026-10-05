# AI Technical Interview Coach

## Overview

An MCP server that turns Claude into a personalized technical interview tutor.

Instead of giving everyone the same random LeetCode questions, the coach builds an interview curriculum around **the person, their experience, and the specific job they are applying for**.

The goal is to simulate how a strong technical interviewer would actually prepare and interview a candidate.

---

# MCP Architecture

The MCP should be deliberately narrow.

**Claude is the interviewer. The MCP is the interviewer's memory and toolkit.**

Claude is responsible for:

- Conducting the conversation
- Reasoning about candidate answers
- Choosing how to respond
- Asking follow-up questions
- Generating interview questions
- Evaluating nuanced responses
- Deciding when to give hints
- Deciding what to test next

The MCP is responsible for:

- Persisting candidate information
- Persisting target jobs
- Persisting interview sessions
- Tracking interview performance
- Maintaining the candidate's skill history
- Retrieving relevant information for Claude
- Recording structured results

The MCP should **not** try to duplicate Claude's reasoning.

---

# Exact MCP Tool Boundaries

The first version should expose **8 tools**.

## 1. `get_candidate_profile`

### Purpose

Retrieve the candidate's persistent profile.

### Input

```json
{
  "candidate_id": "string"
}
```

### Returns

```json
{
  "candidate_id": "string",
  "resume": "...",
  "experience": [],
  "projects": [],
  "skills": [],
  "interests": [],
  "preferences": [],
  "skill_assessment": {}
}
```

### Ownership

**MCP owns:** storing and retrieving candidate information.

**Claude owns:** interpreting the profile and determining what is relevant.

---

## 2. `update_candidate_profile`

### Purpose

Persist changes to the candidate profile.

### Input

```json
{
  "candidate_id": "string",
  "updates": {
    "skills": [],
    "experience": [],
    "interests": [],
    "preferences": []
  }
}
```

### Ownership

**MCP owns:** persistence, validation, and versioning.

**Claude owns:** deciding what information is worth saving.

---

## 3. `get_target_job`

### Purpose

Retrieve a job the candidate is preparing for.

### Input

```json
{
  "job_id": "string"
}
```

### Returns

```json
{
  "job_id": "string",
  "company": "Palantir",
  "title": "Software Engineer Intern",
  "description": "...",
  "requirements": [],
  "location": "..."
}
```

### Ownership

**MCP owns:** job storage and retrieval.

**Claude owns:** interpreting the job and determining likely interview requirements.

---

## 4. `create_interview`

### Purpose

Create a persistent interview session.

### Input

```json
{
  "candidate_id": "string",
  "job_id": "string",
  "interview_type": "technical"
}
```

### Returns

```json
{
  "interview_id": "string",
  "candidate_id": "string",
  "job_id": "string",
  "status": "active"
}
```

The MCP does **not** generate the interview plan or questions.

Claude decides what the interview should contain.

---

## 5. `record_interview_event`

### Purpose

Persist the **raw chronological record** of what happened during an interview.

This is the **single source of truth for interview activity**.

### Input

```json
{
  "interview_id": "string",
  "event": {
    "type": "question_answered",
    "category": "graphs",
    "difficulty": "medium",
    "question": "...",
    "answer": "...",
    "hints_used": 1,
    "metadata": {}
  }
}
```

Possible event types:

```text
question_asked
question_answered
hint_requested
hint_given
follow_up
evaluation
topic_completed
```

### Ownership

**MCP owns:** the immutable event history.

**Claude owns:** deciding what happened and what the event means.

### Important

`record_interview_event` does **not** update the candidate's skill scores.

It only records what happened.

This keeps the event log factual and prevents it from becoming a second skill database.

---

# 6. `get_interview_context`

### Purpose

Retrieve everything Claude needs to continue an interview.

### Input

```json
{
  "interview_id": "string"
}
```

### Returns

```json
{
  "candidate": {},
  "job": {},
  "interview": {},
  "previous_events": [],
  "skill_history": {},
  "recent_performance": {}
}
```

This should be the **main read tool during an active interview**.

---

# 7. `update_skill_assessment`

### Purpose

Persist the candidate's **current skill model**.

This is separate from the interview event log.

### Input

```json
{
  "candidate_id": "string",
  "skills": [
    {
      "skill": "graphs",
      "score": 5,
      "confidence": 0.8,
      "evidence": "Struggled with BFS/DFS problem and required one hint."
    }
  ]
}
```

### Ownership

**Claude owns:** determining the assessment.

**MCP owns:** storing the latest assessment.

### Important

The skill assessment is a **derived state**, not an event.

For example:

```text
Raw events:
    Candidate failed graph problem
    Candidate requested hint
    Candidate solved second graph problem

             ↓ Claude evaluates

Current assessment:
    Graphs = 6/10
    Confidence = 0.8
```

The MCP stores the resulting assessment but does not independently calculate it.

### Historical skill changes

The MCP should optionally retain assessment history:

```text
Graphs
────────────────────────
Interview 1: 4/10
Interview 2: 5/10
Interview 3: 6/10
Current:     6/10
```

The **current assessment** is the canonical candidate skill state.

The historical interview events remain the canonical evidence.

---

# 8. `finish_interview`

### Purpose

Close an interview and persist its **final session-level evaluation**.

### Input

```json
{
  "interview_id": "string",
  "overall_score": 7.6,
  "category_scores": {
    "algorithms": 7,
    "systems": 8,
    "communication": 6,
    "debugging": 9
  },
  "strengths": [],
  "weaknesses": [],
  "recommendations": []
}
```

### Ownership

**Claude owns:** the evaluation and recommendations.

**MCP owns:** storing the final evaluation and closing the session.

### Important

`finish_interview` owns the **final evaluation of that interview only**.

It does **not** own the candidate's long-term skill model.

If Claude discovers that graphs should change from 5/10 to 6/10, it calls:

```text
update_skill_assessment
```

Then:

```text
finish_interview
```

stores the session's final result.

---

# Result Ownership

There are now three distinct types of information:

```text
┌─────────────────────────┐
│ INTERVIEW EVENTS        │
│                         │
│ What actually happened  │
└────────────┬────────────┘
             │
             │ evidence
             ▼
┌─────────────────────────┐
│ SKILL ASSESSMENT        │
│                         │
│ What we currently think │
│ the candidate can do    │
└─────────────────────────┘

┌─────────────────────────┐
│ INTERVIEW EVALUATION    │
│                         │
│ How this specific       │
│ interview went          │
└─────────────────────────┘
```

### Source of truth

| Data | Owner | Purpose |
|---|---|---|
| Interview events | `record_interview_event` | Immutable history of what happened |
| Current skill scores | `update_skill_assessment` | Current candidate model |
| Interview score | `finish_interview` | Final result for one interview |
| Candidate profile | `update_candidate_profile` | Persistent facts/preferences |
| Job | `get_target_job` | Target role information |

No tool should write another tool's primary data.

---

# What Happens After an Interview

Claude might determine:

```text
Candidate struggled with graphs.
Candidate communicated poorly.
Candidate demonstrated strong systems knowledge.
```

Claude then performs three separate operations:

### 1. Record evidence

```text
record_interview_event()
```

Stores the actual questions, answers, hints, and observations.

### 2. Update long-term skills

```text
update_skill_assessment()
```

Updates:

```text
Graphs: 4 → 5
Communication: 6 → 6
Systems: 8 → 8
```

### 3. Close the interview

```text
finish_interview()
```

Stores:

```text
Overall: 7.2/10

Strengths:
- Systems reasoning

Weaknesses:
- Graph algorithms
- Communication

Recommendations:
- Practice graph traversal
- Practice explaining approaches before coding
```

Each operation has a single purpose.

---

# No Automatic Hidden Mutations

The MCP should **not** automatically update skills when `record_interview_event` is called.

For example:

```text
record_interview_event(
    type = "question_answered"
)
```

must not secretly modify:

```text
graphs = 5
```

Likewise, `finish_interview` must not silently overwrite the candidate's long-term skill model.

This makes the system:

- Easier to debug
- Easier to test
- Easier to reason about
- More transparent to Claude
- Less likely to accumulate contradictory state

---

# Error Handling & Validation

The MCP should use **strict input validation and structured errors**.

Claude should never have to guess whether an operation succeeded.

## General Rules

Every tool must:

1. Validate all input before touching the database.
2. Verify referenced entities exist.
3. Verify the operation is valid for the entity's current state.
4. Perform the operation atomically.
5. Return a clear success or error response.
6. Never silently ignore invalid fields.
7. Never partially update persistent state.

Errors should be machine-readable but understandable to Claude.

### Error format

```json
{
  "success": false,
  "error": {
    "code": "INTERVIEW_NOT_FOUND",
    "message": "Interview 'int_123' does not exist.",
    "field": "interview_id",
    "retryable": false
  }
}
```

Successful operations should use:

```json
{
  "success": true,
  "data": {}
}
```

---

# Validation Rules

## IDs

All IDs must:

- Be present
- Be non-empty strings
- Refer to an existing entity when required

Invalid:

```json
{
  "candidate_id": ""
}
```

Return:

```text
INVALID_ID
```

---

## Candidate Profile

`update_candidate_profile` should reject:

- Unknown fields
- Invalid data types
- Empty candidate IDs
- Oversized resume content
- Malformed structured fields

For example:

```json
{
  "candidate_id": "candidate_123",
  "updates": {
    "skills": "Rust"
  }
}
```

should fail because `skills` must be an array.

---

## Job Validation

A job must contain enough information to be useful.

Required:

```text
company
title
description
```

Optional:

```text
location
requirements
metadata
```

An empty job description should be rejected.

The MCP should not attempt to infer or generate missing job information.

---

## Interview State Validation

Interviews have a simple state machine:

```text
CREATED → ACTIVE → COMPLETED
```

Invalid transitions such as:

```text
COMPLETED → ACTIVE
COMPLETED → COMPLETED
```

should fail.

---

## `record_interview_event` Validation

The event must contain:

```text
type
```

and an `interview_id` referencing an active interview.

Known event types should be enforced.

The MCP should reject malformed events rather than silently storing arbitrary data.

---

## Skill Score Validation

Skill scores should use a consistent scale:

```text
0 ≤ score ≤ 10
0 ≤ confidence ≤ 1
```

The MCP should reject invalid, non-numeric, `NaN`, or infinite values.

---

## Atomic Updates

A tool that updates multiple pieces of state should either:

**succeed completely or change nothing.**

Use a database transaction.

```text
BEGIN
    validate everything
    update all skills
COMMIT
```

If anything fails:

```text
ROLLBACK
```

---

# Retry Behavior

Errors should indicate whether retrying makes sense.

### Retryable

```text
DATABASE_UNAVAILABLE
TEMPORARY_STORAGE_ERROR
TIMEOUT
```

```json
{
  "retryable": true
}
```

### Not retryable

```text
CANDIDATE_NOT_FOUND
JOB_NOT_FOUND
INTERVIEW_NOT_FOUND
INVALID_SCORE
INTERVIEW_ALREADY_COMPLETED
INVALID_EVENT_TYPE
```

```json
{
  "retryable": false
}
```

Claude should fix the input or tell the user rather than repeatedly calling the tool.

---

# Concurrency

The MCP should protect interview state from conflicting updates.

At minimum:

- Use database transactions.
- Check interview status before mutations.
- Prevent an interview from being completed twice.
- Make repeated writes safe where practical.

For the local MVP, SQLite transactions are sufficient.

---

# Claude's Behavior When Tools Fail

Claude should never pretend an operation succeeded.

### Bad

> "I've saved your interview results."

when the MCP returned an error.

### Good

> "I couldn't save the interview results because the interview session no longer exists. I still have the evaluation in this conversation, but it wasn't persisted."

For temporary errors:

> "The interview data couldn't be saved because storage is temporarily unavailable. I'll keep going, but this session may not be persisted."

---

# Error Codes

The initial implementation should standardize a small set of error codes:

```text
INVALID_INPUT
INVALID_FIELD
INVALID_FIELD_TYPE
INVALID_ID

CANDIDATE_NOT_FOUND
JOB_NOT_FOUND
INTERVIEW_NOT_FOUND

INTERVIEW_NOT_ACTIVE
INTERVIEW_ALREADY_COMPLETED

INVALID_EVENT_TYPE
INVALID_INTERVIEW_TYPE

INVALID_SCORE
INVALID_CONFIDENCE

DUPLICATE_RESOURCE
CONFLICT

DATABASE_ERROR
STORAGE_UNAVAILABLE
INTERNAL_ERROR
```

Avoid creating dozens of highly specific error codes in the MVP.

---

# Security & Data Boundaries

The MCP should treat resumes and interview history as private candidate data.

At minimum:

- Never log full resumes.
- Never log complete interview answers unnecessarily.
- Do not expose one candidate's data through another candidate ID.
- Validate IDs before every database query.
- Keep secrets and database credentials outside MCP tool arguments.
- Sanitize error messages so internal database details are not exposed.

For the local MVP, the database can remain local to the user's machine.

---

# Boundary Rule

A simple rule should determine whether functionality belongs in the MCP:

> **If the operation requires reasoning, it belongs to Claude. If it requires persistent state or deterministic data access, it belongs to the MCP.**

### Claude

```text
"What should I ask?"
"Was that answer good?"
"How difficult should the next problem be?"
"What weakness did I discover?"
"Should I give a hint?"
"What does this job actually care about?"
```

### MCP

```text
"What is the candidate's resume?"
"What job are we interviewing for?"
"What happened in the last interview?"
"What is the candidate's current skill history?"
"Save this interview result."
"Save this new skill assessment."
```

---

# Data Model

The initial database can be extremely small.

```text
candidates
    id
    resume
    profile
    created_at
    updated_at

jobs
    id
    company
    title
    description
    metadata
    created_at

interviews
    id
    candidate_id
    job_id
    type
    status
    started_at
    finished_at
    overall_score
    final_evaluation

interview_events
    id
    interview_id
    type
    data
    created_at

skill_assessments
    id
    candidate_id
    skill
    score
    confidence
    evidence
    updated_at

skill_assessment_history
    id
    candidate_id
    skill
    score
    confidence
    evidence
    interview_id
    created_at
```

The `skill_assessment_history` table is optional for the first implementation, but useful if we want to visualize improvement over time.

---

# First-Version Scope

The first version should therefore consist of:

### MCP

- 8 tools
- TypeScript
- SQLite
- Local storage
- Strict schema validation
- Structured errors
- Transactional writes
- No external APIs required

### Claude

- Resume analysis
- Job analysis
- Interview planning
- Question generation
- Adaptive interviewing
- Hint generation
- Evaluation
- Skill assessment

### User

The user only needs to interact with Claude.

The underlying MCP should be invisible to them.

---

# Future MCP Extensions

Only add these once the core interview loop works.

```text
Problem database
Company interview data
LeetCode history
Job search
Resume versioning
Interview analytics
Spaced repetition
Voice interview state
```

These should be separate capabilities rather than bloating the initial MCP.

The fundamental architecture should remain:

```text
             ┌──────────────────────┐
             │        CLAUDE        │
             │                      │
             │ Interview reasoning  │
             │ Question generation  │
             │ Evaluation           │
             │ Adaptation            │
             └──────────┬───────────┘
                        │ MCP
                        ▼
             ┌──────────────────────┐
             │   INTERVIEW COACH    │
             │        MCP           │
             │                      │
             │ Candidate state      │
             │ Job state            │
             │ Interview state      │
             │ Skill history        │
             │ Persistent storage   │
             └──────────────────────┘
```

**The MCP should be boring. The intelligence should live in Claude.**
