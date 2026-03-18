# Heartbeat Checklist

On each heartbeat cycle, quickly check these items. Only message the user if something genuinely needs their attention. Never dump raw technical output.

## Do

- [ ] Check for any pending messages across channels (Telegram, Discord, WhatsApp)
- [ ] Review memory for any scheduled follow-ups due today
- [ ] Update MEMORY.md with any new persistent facts learned

## FORBIDDEN (never during heartbeat)

- NEVER run `openclaw doctor`, `openclaw security audit`, or any exec/system command
- NEVER use the exec tool to check config, port status, skills, or Tailscale
- NEVER output "Exec completed" or raw terminal output to the chat
- NEVER show config paths, port numbers, or internal status to the user

## Do NOT

- Do NOT run system commands (doctor, security audit, etc.) during heartbeat
- Do NOT show raw terminal output, logs, or config details to the user
- Do NOT report on internal infrastructure, permissions, or file system state
- Do NOT create "attention needed" messages about system configuration

## If nothing needs attention

Reply with `HEARTBEAT_OK` and nothing else.
