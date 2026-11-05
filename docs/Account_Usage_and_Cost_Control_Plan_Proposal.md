# Account Usage and Cost Control Plan

**Status:** Initial discussion proposal  
**Implementation status:** No coding or database changes yet

## Proposal summary

Introduce role-based cost controls for video generation. Regular editors receive a standard usage
allowance, while trusted editors receive higher limits for normal production work. When an editor
exceeds their allowance, they can request approval before generating additional videos.

The goal is to control company spending without unnecessarily slowing down trusted production
work.

## Problems to solve

- Unnecessary or low-quality renders waste company credits.
- Editors can exceed a reasonable usage allowance.
- There is no approval process when an editor needs additional credits.
- Usage and spending visibility per account is limited.
- Multiple users can collectively exceed the company budget.
- Editors can start expensive renders without first reviewing the estimated cost.

## Proposed account types

- **Regular editor:** Receives a standard usage allowance and needs approval after exceeding it.
- **Trusted editor:** Receives a higher allowance for regular production work.
- **Render approver:** Reviews requests for additional usage.
- **Admin:** Manages account access, usage limits, and company-level controls.

## Proposed workflow

1. The editor prepares and reviews the scenes and reference frames.
2. The system displays the estimated generation cost.
3. If the editor is within their allowance, they can confirm and start rendering.
4. If the render would exceed their allowance, they submit an approval request with a reason.
5. A render approver reviews the project, estimated cost, and the editor's current usage.
6. The approver approves or rejects the request.
7. An approved render proceeds, and its actual usage is recorded.
8. A company-wide budget limit acts as the final safeguard for every account.

## Expected benefits

- Better control over company spending.
- Clear usage visibility for each editor.
- Fewer unnecessary or poorly reviewed renders.
- A controlled way to exceed an allowance when the additional usage is justified.
- Efficient production work for trusted editors.
- Company-wide visibility into overall usage and costs.

## Decisions needed before implementation planning

- Should limits be daily, monthly, or both?
- How should the limits for regular and trusted editors differ?
- Who can approve additional usage?
- What project, cost, and usage information should an approver see?
- What should the company-wide budget safeguard be?
- Which capabilities are required for the MVP?


