---
"@kitlangton/stack": patch
---

Support mixed linear and parallel stack shapes by separating merge path selection (`merge --auto --through`) from PR stack-block rendering, so auto-merge follows the selected branch and stack blocks no longer pull in an arbitrary sibling at a fork point.
