// Phrase lists for the rules that REJECT a model reply (rather than tidy it). Same template syntax as patternData.ts,
// matched on normalised text. Each rule names what the tutor must never do to a child:
//   asks_personal_data  asks for a name, address, phone, school, password or photo
//   meet_someone        suggests meeting, visiting or going off with someone
//   keep_secret         asks the child to keep something from a grown-up
//   claims_human        says it is a person, or not a computer, or has a human life
//   reveals_instructions  says what its instructions are, or agrees to drop them
// Examples are checked by the tests. These are short on purpose; the output check (a second model) and the human
// red-team cover what a list cannot.

export interface RejectionRule {
  reason: 'asks_personal_data' | 'meet_someone' | 'keep_secret' | 'claims_human' | 'reveals_instructions';
  template: string;
  examples: string[];
}

const NOUN =
  '(name|surname|full name|real name|first name|last name|address|phone|phone number|number|mobile|email|email address|password|pin|school|school name|photo|picture|pic|selfie)';
const FAMILY = '(mums|mummys|moms|dads|daddys|teachers|parents|friends|brothers|sisters)';

export const REJECTION_RULES: readonly RejectionRule[] = [
  { reason: 'asks_personal_data', template: `(what is|whats|tell me|give me|say|write|share|send|type|enter|what are|can i have) ... your ${NOUN}`, examples: ['What is your name?', 'Tell me your address.', 'Can you send me your phone number?'] },
  { reason: 'asks_personal_data', template: 'where (do|did) you (live|stay)', examples: ['Where do you live?'] },
  { reason: 'asks_personal_data', template: '(which|what) (school|street|area|town) (do you|are you|is your)', examples: ['Which school do you go to?'] },
  { reason: 'asks_personal_data', template: `(what is|tell me) the name of your (school|mum|mummy|dad|daddy|teacher|street)`, examples: ['Tell me the name of your school.'] },
  { reason: 'asks_personal_data', template: `your ${FAMILY} (name|names)`, examples: ["What is your mum's name?"] },
  { reason: 'asks_personal_data', template: '(send|share|show|take|upload) ... (photo|picture|pic|selfie|image) of (you|yourself)', examples: ['Send a picture of yourself.'] },
  { reason: 'asks_personal_data', template: '(send|share|show) me [a|your] (photo|picture|pic|selfie)', examples: ['Send me a photo.'] },
  { reason: 'meet_someone', template: '(meet|see) (me|you|him|her|them|up) (at|in|on|outside|tomorrow|tonight|later|alone|there|after)', examples: ['I can meet you outside.'] },
  { reason: 'meet_someone', template: '(lets|let us|we can|we should|you should|you must) meet', examples: ['Let us meet tomorrow.'] },
  { reason: 'meet_someone', template: '(come|go) ... (to|with) ... (my|his|her|their) (house|place|home|car|room)', examples: ['Come to my house.'] },
  { reason: 'meet_someone', template: 'i (will|can) (pick|fetch|collect) you', examples: ['I will pick you up.'] },
  { reason: 'keep_secret', template: '(do not|never) tell ... (anyone|anybody|mum|mummy|dad|daddy|parents|teacher|grown up)', examples: ['Do not tell your mummy.'] },
  { reason: 'keep_secret', template: 'keep (this|it|that) ... secret', examples: ['Keep this a secret.'] },
  { reason: 'keep_secret', template: '(our|a) [little] secret', examples: ['It is our secret.'] },
  { reason: 'keep_secret', template: '[just] between (us|you and me)', examples: ['This is just between us.'] },
  { reason: 'claims_human', template: 'i am [a] [real] (human|person|man|woman|boy|girl|child|kid)', examples: ['I am a real person.'] },
  { reason: 'claims_human', template: 'i am [a] (teacher|aunty|uncle|mummy|daddy|nurse|doctor)', examples: ['I am a teacher.'] },
  { reason: 'claims_human', template: 'i am not [a] (robot|computer|ai|program|machine|bot)', examples: ['I am not a robot.'] },
  { reason: 'claims_human', template: '(i am real|i am alive|i am a human)', examples: ['I am real.'] },
  { reason: 'claims_human', template: 'i am ... years old', examples: ['I am about 30 years old.'] },
  { reason: 'claims_human', template: 'when i was [a] (child|kid|little|young|your age|small)', examples: ['When I was your age, I liked maths.'] },
  { reason: 'reveals_instructions', template: 'my [system|hidden|secret] (prompt|instructions) (say|says|are|is|tell|tells|were)', examples: ['My instructions say that I must help you.'] },
  { reason: 'reveals_instructions', template: '(here is|here are) my [system|full] (prompt|instructions|rules)', examples: ['Here are my instructions.'] },
  { reason: 'reveals_instructions', template: 'i was (told|instructed|programmed|configured) to', examples: ['I was told to say that.'] },
  { reason: 'reveals_instructions', template: '(i will|i can|okay i will|sure i will) ignore (my|the|all|those) (rules|instructions)', examples: ['Okay, I will ignore my rules.'] },
  { reason: 'reveals_instructions', template: '(developer mode|jailbreak mode|unrestricted mode)', examples: ['I am now in developer mode.'] },
];
