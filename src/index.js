const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        if (request.method === "GET" && url.pathname === "/api/tasks") {
          const { results } = await env.DB.prepare(
            "SELECT id, title, due_date, priority, completed, created_at FROM tasks ORDER BY completed ASC, due_date ASC, id DESC"
          ).all();
          return json({ tasks: results });
        }

        if (request.method === "POST" && url.pathname === "/api/tasks") {
          const body = await request.json();
          const title = String(body.title || "").trim();
          const dueDate = String(body.dueDate || "").trim();
          const priority = ["low", "medium", "high"].includes(body.priority) ? body.priority : "medium";

          if (!title || !dueDate) return json({ error: "Title and due date are required." }, 400);

          const result = await env.DB.prepare(
            "INSERT INTO tasks (title, due_date, priority) VALUES (?, ?, ?)"
          ).bind(title, dueDate, priority).run();

          return json({ id: result.meta.last_row_id }, 201);
        }

        const id = Number(url.pathname.split("/").pop());

        if (request.method === "PATCH" && url.pathname.startsWith("/api/tasks/") && Number.isInteger(id)) {
          const body = await request.json();
          const completed = body.completed ? 1 : 0;
          await env.DB.prepare("UPDATE tasks SET completed = ? WHERE id = ?").bind(completed, id).run();
          return json({ ok: true });
        }

        if (request.method === "DELETE" && url.pathname.startsWith("/api/tasks/") && Number.isInteger(id)) {
          await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }

        return json({ error: "Not found" }, 404);
      } catch (error) {
        return json({ error: "Something went wrong.", detail: error.message }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
