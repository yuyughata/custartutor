# Safeguarding protocol for the AI tutor (DRAFT for the owner)

**Status: DRAFT. Not approved. Not legal or child-protection advice.** The tutor cannot be switched on until a named
safeguarding owner has reviewed and approved this protocol (the system enforces it: `set_tutor_enabled` refuses
without a confirmed `safeguarding.owner`). Everything in square brackets needs a decision or a verified fact from the
owner. Have a qualified child-protection professional and Nigerian counsel (Child's Rights Act 2003 and the state
laws that apply to your families; the Nigeria Data Protection Act 2023) review it before launch.

## 1. Why this exists

Children talk to the tutor alone, often on a parent's phone. Some will say something that is not about the lesson:
that they want to hurt themselves, that someone is hurting them, that they are frightened or very sad. The risk can
be inside the household, so telling the household automatically could make a child less safe. The tutor is a
computer program, not a counsellor and not an emergency service. This protocol defines what it says, what the
system records, who looks, and what happens next.

## 2. What the tutor does in the chat

1. It never improvises in these moments. The reply is **fixed, human-approved text** (the owner edits the wording in
   settings; the defaults are in `DEFAULT_SAFE_REPLIES`). The model is not called for the reply.
2. It is short, warm and in plain words. It thanks the child, says the feeling matters, says it is not the child's
   fault (for abuse), and points to **a grown-up the child trusts**.
3. It does **not**: promise secrecy; ask questions to find out more; give advice, diagnosis or counselling; name
   anyone; say what will happen next; threaten consequences; continue the lesson as if nothing happened.
4. It does not show emergency numbers unless the owner supplies **verified** ones in `tutor.helpline` [owner: supply
   numbers valid in the families' states, check them yearly, and decide whether to show them to children].
5. The next turn after a safe reply is handled normally; the session stays open.

## 3. What the system records

| Trigger                                     | Reply     | Case   | Guardian sees the turn          |
| ------------------------------------------- | --------- | ------ | ------------------------------- |
| Self-harm, any severity                     | self_harm | high   | no, until a reviewer decides    |
| Abuse or neglect disclosure, any severity   | abuse     | high   | no, until a reviewer decides    |
| Strong distress (fear, sadness, loneliness) | distress  | medium | no, until a reviewer decides    |
| Sexual content or graphic violence          | blocked   | low    | yes                             |
| Trying to break the tutor's rules           | redirect  | none   | yes                             |
| Personal data typed in                      | (normal)  | none   | yes (the data is removed first) |

A case holds: the category, a severity, the session, the child's alias, and a **redacted excerpt** (the last few
messages with names, numbers and addresses removed). Raw text is never stored. Detection uses a classifier plus fixed
patterns for the most serious phrases; it **will miss things and will flag harmless things**. Nobody should treat a
quiet queue as proof that no child is at risk.

## 4. Who looks, and how fast

- Cases appear in the admin app's safeguarding queue. Only the `safeguarding` role and `super_admin` (both at
  aal2) can open it; **every read is written to the audit log**. Support, analysts and editors cannot.
- Target time to first look: high [4 hours], medium [24 hours], low [72 hours]. [Owner: set real targets you can
  keep, including nights and weekends, and a named deputy. An unkept target is worse than a longer honest one.]
- The owner is [name, role, contact]. The deputy is [name, contact]. Reviewers are trained [how, by whom] and
  have access to support for themselves; this work is distressing.

## 5. What a reviewer can decide

For each case the reviewer records a decision and a note:

1. **No action, false alarm.** The held turns are released to the guardian's transcript.
2. **Keep withheld, no contact.** Used when contacting the household may increase the risk.
3. **Contact the guardian** with an approved message [owner: wording, channel, who sends it].
4. **Escalate externally** to [the agency or authority, contact details, and the conditions under which this is
   done and by whom]. [Owner and counsel: decide what is required or permitted in each state.]

The system never contacts a household, an agency or anyone else by itself.

## 6. Data

Case excerpts are kept until the case is closed plus [N] months, then deleted [owner and counsel: decide]. Ordinary
tutor messages are kept for `tutor.retention_days` (default 90) and then purged. No exports. Reviewers see the
alias, never an account email. [Owner and counsel: lawful basis, notices to households, DPIA, NDPC registration.]

## 7. Before launch

- [ ] Owner and deputy named; `safeguarding.owner` confirmed in settings.
- [ ] Safe replies and the consent text reviewed and approved by a child-protection professional.
- [ ] Targets, escalation contacts and the household message agreed and written down.
- [ ] Pidgin and local-language phrases added to the pattern list (the first list is English only).
- [ ] Human red-teaming of the tutor by people who are not its builders, with notes kept.
- [ ] The live adversarial run (`packages/tutor-core`) passes and its results are reviewed by the owner.
- [ ] Incident procedure: what to do if the tutor says something harmful, or a case is missed.
- [ ] Anthropic's data handling and the cross-border transfer are reviewed and disclosed to households.
