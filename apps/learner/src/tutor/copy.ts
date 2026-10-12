/** Child-facing wording of the tutor, in one place so it can be reviewed. Simple words, short sentences. */

export const TUTOR_COPY = {
  entryButton: 'Ask my tutor',
  panelTitle: 'My tutor',
  close: 'Close',
  /** Always visible in the panel header. States plainly what the tutor is. */
  notice: 'This is a computer program, not a person. It can make mistakes.',
  demoNotice: 'Demo tutor: not Claude. These are pretend replies for testing.',
  demoTag: 'Demo tutor: not Claude',
  emptyLive: 'Ask a question about your lesson.',
  inputLabel: 'Type your question',
  inputPlaceholder: 'Type here',
  send: 'Send',
  thinking: 'Thinking…',
  retry: 'Try again',
  useLite: 'Use the offline tutor',
  litePractice: 'Practise with the offline tutor',
  checking: 'Getting your tutor ready…',
  listen: 'Listen',
  stopListening: 'Stop',
  tryQuestion: 'Try this question',
  hideQuestion: 'Hide the question',
  questionWhere: 'You can find it in your lesson, in',
} as const;

export const LITE_COPY = {
  notice: 'This is the offline tutor: it follows the lesson script.',
  whichPart: 'Which part do you want to talk about?',
  noScript: 'The offline tutor has nothing for this lesson yet.',
  hint: 'Hint',
  skip: 'Skip',
  typeAnswer: 'Type your answer',
  send: 'Send',
  change: 'Choose another part',
  finished: 'You finished this part.',
  again: 'Start this part again',
  welcomeBack: 'Welcome back! Let us carry on.',
  hintsOut: 'There are no more hints for this one.',
} as const;

/** Quick replies for children who cannot read or type yet (live chat). Plain statements the tutor can answer. */
export const PRE_READER_QUICK_REPLIES = [
  { label: 'Say it again', text: 'Please say that again.' },
  { label: 'Tell me more', text: 'Please tell me more.' },
  { label: 'I do not understand', text: 'I do not understand. Please help me.' },
] as const;
