# Designer Agent - Task Processing Instructions

When asked to "process designer tasks" or "run designer agent", follow these steps:

1. Fetch pending tasks from: `curl http://localhost:3004/designer/tasks`
2. For each task with `status: "pending"`:
   a. Update status to "processing": `curl -X PATCH http://localhost:3004/designer/tasks/{id} -H "Content-Type: application/json" -d '{"status":"processing"}'`
   b. Use the Canva `generate-design` tool with:
      - `design_type`: from the task
      - `query`: the task description
      - `brand_kit_id`: from the task (if set)
   c. Pick the best candidate and use `create-design-from-candidate`
   d. Get the design info with `get-design`
   e. Export as PNG with `export-design`
   f. Update the task with results: `curl -X PATCH http://localhost:3004/designer/tasks/{id} -H "Content-Type: application/json" -d '{"status":"completed","result_url":"...","result_thumbnail":"...","result_design_id":"..."}'`
   g. If any step fails, update: `curl -X PATCH ... -d '{"status":"failed","error":"..."}'`
