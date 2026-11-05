# Render Attempt Accounting Findings

## Goal

Make sure every fal render attempt can be tracked, especially when money may have been spent.

The `runs` table is already intended to store **one row per render attempt**, but the worker does not fully do this yet.

## What we found

### 1. Successful renders are tracked

When a render finishes and ingestion succeeds, `MarkDone()`:

- saves the generated asset;
- creates a `runs` record;
- marks the scene as `done`.

This happens in one database transaction.

### 2. Failed renders may not be tracked

`MarkFailed()` currently only changes the scene status to `failed`.

It does not create or update a render-attempt record.

This means some failed renders may cost money without appearing correctly in our cost history.

### 3. No request ID does not always mean no charge

We cannot assume a render was never submitted just because we did not receive a `kie_task_id`.

For example:

1. We send the request to fal.
2. fal accepts it.
3. Our connection times out before we receive the response.

fal may still be processing the render even though our worker does not have its request ID.

These cases should be treated as **unknown**, not automatically as unbilled.

### 4. Create the attempt before calling fal

A safer flow would be:

`Create attempt → Submit to fal → Save request ID → Process result → Update billing`

This gives us a database record before anything that may cost money happens.

The attempt can then end as something like:

- submitted;
- succeeded;
- failed;
- submission unknown.

Billing can separately be:

- not billable;
- charged;
- unknown;
- refunded.

### 5. Each attempt needs its own vendor request ID

Currently the fal request ID is stored on the scene.

This becomes a problem when the same scene is retried or re-rendered.

Each attempt should keep its own `vendor_request_id` so we preserve the full history.

### 6. Cost history must survive deletion

Currently deleting a scene can also delete its `runs` records.

Even if we keep the run, we still need to know which user/project/account generated that cost.

We need either:

- durable project/account information stored with the attempt; or
- a soft-delete approach for billing-related records.

### 7. Estimated cost is not the same as actual charge

The worker currently calculates cost using our local pricing rules.

That is an **estimated cost**, not necessarily a vendor-confirmed charge.

We should consider separating:

- `estimated_cost`
- `charged_cost`
- `billing_status`

## Proposed flow

The basic design should be:

1. Create an attempt in the database.
2. Save the model, settings, account/project, and estimated cost.
3. Submit the render to fal.
4. Save the returned vendor request ID.
5. Track whether the render succeeds, fails, or becomes unknown.
6. Track billing separately.
7. Update the same attempt instead of creating it only after success.

## Before implementation

Dev A and Dev B should agree on:

- attempt statuses;
- billing statuses;
- fields needed in the `runs` table;
- how retries and re-renders are represented;
- how cost history survives deletion;
- whether fal supports safe/idempotent submissions.

## Conclusion

The problem is bigger than simply adding a `runs` insert to `MarkFailed()`.

We need a reliable attempt record **before calling fal**, so every render that may cost money can be traced from submission through completion and billing.