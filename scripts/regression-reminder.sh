#!/usr/bin/env bash
# UserPromptSubmit hook (.claude/settings.json): when the owner's message reads
# like a regression report -- something that used to work and no longer does --
# remind the session to log it in docs/REGRESSIONS.md. It only adds context; it
# never blocks a prompt, and a message that matches by accident costs one
# sentence of context.
set -u

prompt=$(jq -r '.prompt // empty' 2>/dev/null) || exit 0

# Only the owner's own words: agent reports, task notifications and other
# injected messages arrive wrapped in a tag and may well say "regression".
case "$(printf '%s' "$prompt" | sed -e 's/^[[:space:]]*//' | head -c 40)" in
  '<agent-message'* | '<task-notification'* | '<cross-session-message'* | '<system-reminder'*) exit 0 ;;
esac

pattern='used to work|stopped working|no longer work|not working any ?more|(doesn|does not|isn|is not|don|do not).{0,3}work(ing)? any ?more|worked before|was working|regress|broke|broken again|works? again'

if printf '%s' "$prompt" | grep -Eiq "$pattern"; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "This message may report a regression: something that used to work and no longer does. Once you have confirmed it is one, add a brief entry to docs/REGRESSIONS.md in the right section: what broke, a short concrete example of how it showed up, the cause once known, and the rule that prevents it (see the Past regressions section of CLAUDE.md). Update the entry when the cause or fix is found. If it is not a regression, ignore this."
    }
  }'
fi
exit 0
