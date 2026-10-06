# LifeOS

LifeOS is a mobile-first personal productivity hub.

## Modules
- Deadline: assignments and tasks
- ReadEasy: simplify confusing text
- ReplyBot: help with replies
- DigitalDeclutter: organize digital clutter

## Stack
- GitHub
- Cloudflare Workers
- Cloudflare D1

## Deadline MVP
Create, complete, and delete tasks with a title, due date, and priority. Tasks are stored in D1.

### Deploy
1. Install Wrangler.
2. Log in with `wrangler login`.
3. Create/use the D1 database named `lifeos`.
4. Put its ID in `wrangler.jsonc`.
5. Run `wrangler d1 execute lifeos --remote --file=schema.sql`.
6. Run `wrangler deploy`.

The frontend is served directly by the Worker, so there is no separate frontend host to manage.
