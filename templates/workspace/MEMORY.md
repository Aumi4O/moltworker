# Persistent Memory

## Infrastructure

- Running on Cloudflare Workers with Sandbox container (standard-1, 4 GiB)
- R2 storage for persistent backup (auto-syncs every 2 minutes)
- Using Codex subscription (free) for AI — OAuth login required after restarts
- OAuth endpoint: /debug/oauth-codex
- Admin UI: /_admin/
- Gateway port: 18789

## Agent Team

- 10 agents configured: main, research, coding, email, social, general-1 through general-5
- All agents share Codex OAuth subscription
- Each agent has its own auth-profiles and session history
- Backups include all agent data

## Important Notes

- After container restart, check if Codex OAuth needs refresh
- R2 backup preserves all agent configs, workspaces, and auth profiles
- Container may sleep after idle period — first request wakes it
