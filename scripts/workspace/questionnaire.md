<!-- mneme workspace: the first-time questionnaire. Refreshed by every install (scripts/install-windows.ps1): the person's own rules live in rules.md, not here. -->
# The questionnaire

Ten short questions so that anyone using this workspace (to study, write, run a business, program...) starts with rules of their own. Claude proposes rules from the answers; the person picks which go in. Each goes in marked **declared**: it comes from what they said, not from what was seen in use, and use later confirms or retires it. About 5 minutes; any question can be skipped.

## For the AI running it

**Offering it.** When to offer it (in the first reply of the first conversation, whatever they opened with) and how `rules.md` records that is in `CLAUDE.md` (First time: the questionnaire). Offer it in one line, in their words: "Want me to ask you ten quick questions (about 5 minutes) so you start with rules of your own? You can skip any."

**Asking.**
- Ask in the person's language and register, in everyday words (the table in `CLAUDE.md` applies): keep the meaning, not the English wording.
- Say once at the start: ten questions in four parts; "skip" skips one, "enough" stops.
- **One question per message.** Offer two or three of its examples as options, choosing the ones that fit what they do (question 4 tells you).
- Don't ask what you already know from this conversation or `rules.md`: confirm it in one line instead.
- At most one follow-up per question, only to make an answer concrete ("short: about how many lines?").
- Propose and write nothing until the questions are over.

**Turning answers into rules.** At the end, or when they say "enough":
- One rule per useful answer, often none. 3 to 8 in total, **never more than 8**: every rule is read in every window, so fewer is better. If more pass the filters below, propose the 8 that matter most and say in one line how many you left out (they can ask for them).
- Keep a rule only if all of these hold:
  1. **Checkable:** you could look at one reply and say whether it followed the rule. "Be clear" fails; "At most 5 lines unless I ask for more" passes.
  2. **Theirs:** it says what they said. The examples below show the shape of a good rule, never its content.
  3. **New:** not already in `CLAUDE.md` or `rules.md`. Searching the notes first, keeping their history, several windows at once and the five note-writing rules are already there.
  4. **Compatible:** it does not go against `CLAUDE.md`. If an answer does, don't propose it: say in one line which workspace rule it bumps into and why that rule exists. Changing `CLAUDE.md` is theirs to do, knowingly.
  5. **A rule, not a fact:** "I'm a nurse" is a fact (a note, if they want); "Use medical terms without defining them" is a rule.
- Each rule: one imperative line, in their language, 20 words at most.
- Show them all together, numbered, each with the answer it came from in a few words. They reply "all", the numbers they want, "none", or a change to any of them.
- Right before writing, read `rules.md` again: it is outside the notes folder, so Mneme keeps no history of it and does not stop another window from changing it. Add the chosen rules in one edit and show the lines as written. What they turned down is written nowhere and not offered again.
- Taking the questionnaire again later: an answer that changes an existing rule is proposed as a replacement of that line, never as a second rule.

## The questions

Each says **why** it is asked, the **rule** it can produce, good rules from typical answers (**e.g.**), and when **no rule** comes out.

### Part 1 · How you like to be answered

**1. Language.** "I'll answer you in <their language>. Should anything be different: how formal I am, a regional variant, notes in another language, words that stay as they are (code, terms of your field)?"
- Why: `CLAUDE.md` already answers in their language; only the exceptions make a rule. Rule: language or register.
- E.g. `Use "vos" (Rioplatense Spanish), never "tú".` · `Write notes in English even when we talk in Spanish.`
- No rule: "just my language", "whatever".

**2. Length.** "When you ask me something, what works better: the short answer and you ask for more, or the full explanation from the start?"
- Why: `CLAUDE.md` puts the answer first; this sets how much comes after it. Rule: length or depth.
- E.g. `Answer in at most 5 lines unless I ask for detail.` · `When you explain an idea, add one concrete example.`
- No rule: "it depends", "normal".

**3. Shape.** "Is there anything about how answers look that you like or can't stand? Lists, tables, headings, emojis, bold text, opening phrases..."
- Why: most complaints about an AI are about form, and form is easy to check. Rule: format.
- E.g. `No emojis.` · `Never open with praise ("Great question!").`
- No rule: no preference.

### Part 2 · What you use it for

**4. Main use.** "What will you mostly do here: study, write, run a business, program, organize a project...? And how much do you already know about it?"
- Why: it picks the examples for the next questions, and their level sets how much to explain. Rule: level of explanation.
- E.g. `I'm new to programming: explain any command before asking me to run it.` · `I'm an accountant: skip basic accounting definitions.`
- No rule: the use alone ("to study") is context for the next questions, not a rule.

**5. What goes in the notes.** "What do you want to keep in your notes: class summaries, drafts, clients, decisions, ideas...? Does any of it have a fixed name, place or shape?"
- Why: `CLAUDE.md` says how any note is written; this is what is particular to theirs. Rule: a note convention.
- E.g. `One note per client, "Client - <name>", with sections Contact, Orders, Pending.` · `Class notes go in "Uni/<subject>/" and start with the class date.`
- No rule: "stuff", "everything".

**6. Writing on its own.** "Should I save things to your notes when they seem useful, ask you each time, or only when you tell me to?"
- Why: Claude can write their notes; some people want every change to be theirs. Rule: how much Claude writes without asking.
- E.g. `Only write to my notes when I ask; otherwise offer it in one line.` · `When we decide something, add it to that project's note without asking.`
- No rule: "whatever you think".

### Part 3 · What never to do

**7. Ask first.** "Is there something I should never do without asking you first? Deleting or moving files, sending or publishing something, changing notes you wrote yourself, installing programs..."
- Why: every earlier version of a note is kept, so a note edit can be undone; a deleted file or a sent message cannot. Rule: a limit, or an action that needs their OK.
- E.g. `Ask before deleting or moving any file outside the notes folder.` · `Never change the notes in "Journal/"; only read them.`
- No rule: "be careful", "nothing in particular".

**8. Never again.** "Has an AI ever done something that annoyed you, that you don't want to see again?"
- Why: it is a correction they already made somewhere else, the closest this questionnaire gets to evidence from use. Rule: a behavior to avoid.
- E.g. `When I ask you to check a text, point out problems; don't rewrite it unless I ask.` · `Don't add warnings I didn't ask for.`
- No rule: nothing comes to mind, or it is already in `CLAUDE.md` (making up a source, for example).

### Part 4 · How you know it came out right

**9. How you check.** "When I do something for you, how do you check that it's right? You read it over, you try it, you compare it with a source, someone else reviews it..."
- Why: their own check becomes something Claude does before handing work over. Rule: a check before delivering.
- E.g. `When you give me a number, show the calculation.` · `When you change code, run it and tell me what you ran and what came out.`
- No rule: "I trust it", "I just look at it".

**10. Done.** "When a task is finished, what do you want at the end: one line of what changed, the next steps, nothing?"
- Why: it sets how every task closes. Rule: how a task ends.
- E.g. `End every task with one line: what changed and where.` · `If something is left undone, say it first, in one line.`
- No rule: no preference.

## The rule line in rules.md

One rule per line, where `(no rules yet)` is (it goes away with the first rule). The mark after `—` stays in English, exactly as shown, whatever the rule's language, so a check can count them. Dates are the day it happened.

| State | Line |
|---|---|
| From the questionnaire | `- <rule> — declared (questionnaire, YYYY-MM-DD)` |
| Backed up by use | `- <rule> — confirmed (YYYY-MM-DD; declared YYYY-MM-DD)` |
| Born from a correction | `- <rule> — confirmed (YYYY-MM-DD)` |
| Corrected against once | `- <rule> — declared (questionnaire, YYYY-MM-DD; against YYYY-MM-DD)` |
| Retired | under `## Retired`, at the end: `- <rule> — retired (YYYY-MM-DD: <why, a few words>)` |

## The cycle

- **Confirmed:** a declared rule is backed up when they correct you in its direction unprompted: they point out you did not follow it, or ask again for what it says. Silently accepting a reply that followed it proves nothing. Change the mark; the rule's words stay.
- **Against:** they correct you *for following it* (a one-off request the rule already allows does not count). The first time, add `; against <date>` to the mark. The second time, propose in one line to rewrite it or retire it, and do only what they choose: never retire one on your own. If they keep it, remove the `against` mark. A rewrite that comes out of their corrections is born confirmed.
- **Retired** rules move to `## Retired` instead of being deleted, because `rules.md` has no history: they are not followed, and not proposed again unless the person asks for them.
