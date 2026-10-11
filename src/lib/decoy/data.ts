/**
 * The people in the decoy inbox. All fictional. Seeded conversations are
 * written as minutes *before* the moment security mode was turned on, so
 * the inbox starts out looking recently used.
 */

export interface SeedMessage {
  /** Minutes before the epoch. */
  ago: number;
  from: 'me' | 'them';
  text: string;
}

export interface DecoyContact {
  id: string;
  name: string;
  /** Shown under the name in the contact list. */
  detail: string;
  /** Avatar background. */
  color: string;
  seed: SeedMessage[];
  /** Answers to whatever is sent, used in order and then repeated. */
  replies: string[];
  /** Unprompted messages that arrive while the app has not been opened. */
  idle: string[];
  /** Automated senders answer everything the same way (or not at all). */
  automated?: boolean;
}

const H = 60;
const D = 24 * H;

export const CONTACTS: DecoyContact[] = [
  {
    id: 'mum',
    name: 'Mum',
    detail: 'Mobile',
    color: '#C2185B',
    seed: [
      { ago: 3 * D + 2 * H, from: 'them', text: 'Are you still coming for dinner Sunday? Dad wants to do a roast' },
      { ago: 3 * D + H + 40, from: 'me', text: 'Yep should be there by 5. Want me to bring anything?' },
      { ago: 3 * D + H + 12, from: 'them', text: 'Just yourself love. Maybe some of that bread from the bakery if you go past' },
      { ago: 3 * D + H + 5, from: 'me', text: 'Will do 👍' },
      { ago: 22 * H, from: 'them', text: 'Thanks for coming yesterday, Dad really enjoyed it. Did you get home ok?' },
      { ago: 21 * H + 30, from: 'me', text: 'Yeah all good, home about 9. Thanks for dinner, the roast was great' },
      { ago: 21 * H + 26, from: 'them', text: 'Good. Don\'t forget Aunty Carol\'s birthday is on the 14th xx' },
    ],
    replies: [
      'Ok love, talk soon xx',
      'That\'s nice. Dad says hi',
      'Let me know when you\'re free and we\'ll sort something out',
      'Ok. Don\'t work too hard!',
      'I\'ll ask your father and get back to you',
      'Lovely 😊 xx',
    ],
    idle: [
      'Hi love, just checking in. How\'s your week going?',
      'Did you see the weather forecast for the weekend? Might be a good one for the garden',
      'Reminder that Dad\'s appointment is Thursday, could you give him a call after?',
      'Your cousin is in town next month, we should all catch up',
    ],
  },
  {
    id: 'dave',
    name: 'Dave Harrington',
    detail: 'Mobile',
    color: '#00796B',
    seed: [
      { ago: 5 * D + 3 * H, from: 'them', text: 'Fishing Sat? Forecast looks mint, tides are right about 7' },
      { ago: 5 * D + 2 * H + 45, from: 'me', text: 'Keen. Your boat or the wharf?' },
      { ago: 5 * D + 2 * H + 40, from: 'them', text: 'Boat. Pick you up 6, bring the good rod this time 😂' },
      { ago: 5 * D + 2 * H + 38, from: 'me', text: 'Haha one time. See you at 6' },
      { ago: 2 * D + 5 * H, from: 'them', text: 'Still got your chilly bin in the ute, drop it round this week?' },
      { ago: 2 * D + 4 * H + 20, from: 'me', text: 'Sweet, any night after 6 works' },
      { ago: 2 * D + 4 * H + 15, from: 'them', text: 'Wed then. Might stay for a beer if the game\'s on' },
    ],
    replies: [
      'Yeah sweet as',
      'Haha classic',
      'All good mate, call you later',
      '👍',
      'Nah can\'t this week, next week maybe?',
      'Yeah I heard. Crazy aye',
      'Sounds like a plan',
    ],
    idle: [
      'You watching the game tonight?',
      'Mate the snapper were going off this morning, you missed out',
      'Got a spare ticket Saturday if you\'re keen',
      'Dropped the chilly bin at your door, cheers for that',
    ],
  },
  {
    id: 'priya',
    name: 'Priya Nair',
    detail: 'Work',
    color: '#5E35B1',
    seed: [
      { ago: D + 6 * H, from: 'them', text: 'Hey, can we push the 10am to 10:30 tomorrow? Client call is running over' },
      { ago: D + 5 * H + 50, from: 'me', text: 'Sure, 10:30 is fine' },
      { ago: D + 5 * H + 48, from: 'them', text: 'Thanks! I\'ll move the invite' },
      { ago: 4 * H + 10, from: 'them', text: 'Did you get a chance to look at the Q3 numbers? Mark wants a summary by Thursday' },
      { ago: 3 * H + 50, from: 'me', text: 'Halfway through, will send a draft tonight' },
      { ago: 3 * H + 45, from: 'them', text: 'Perfect, no rush past tomorrow morning' },
    ],
    replies: [
      'Great, thanks',
      'Sounds good. Let\'s pick it up tomorrow',
      'Ok noted. I\'ll update the doc',
      'Can you send that through when you get a sec?',
      'No worries 🙂',
      'In a meeting, will reply properly after',
    ],
    idle: [
      'Morning! Reminder the team lunch is Friday 12:30 at the usual place',
      'Mark liked the summary, nice work',
      'Are you in the office tomorrow? Need a second pair of eyes on the deck',
      'FYI the 2pm got moved to Thursday',
    ],
  },
  {
    id: 'tom',
    name: 'Tom Beattie',
    detail: 'Mobile',
    color: '#EF6C00',
    seed: [
      { ago: 6 * D + 2 * H, from: 'them', text: 'Power bill came in, $212. Your half is $106, same account as usual' },
      { ago: 6 * D + H + 30, from: 'me', text: 'Paid 👍' },
      { ago: 6 * D + H + 28, from: 'them', text: 'Legend' },
      { ago: D + 2 * H, from: 'them', text: 'Recycling is tomorrow not Thursday this week, holiday shifted it' },
      { ago: D + H + 40, from: 'me', text: 'Ah good call, I\'ll put it out tonight' },
      { ago: 9 * H, from: 'them', text: 'Someone left the back door unlocked last night, was that you?' },
      { ago: 8 * H + 30, from: 'me', text: 'Not me, I came in the front. Might have been Chloe after the gym?' },
      { ago: 8 * H + 25, from: 'them', text: 'I\'ll ask her. Cheers' },
    ],
    replies: [
      'All good',
      'Cheers',
      'Yeah I\'ll be home about 7 if you need me',
      'Haha yeah',
      'Can you grab milk if you\'re at the shop?',
      '👍',
    ],
    idle: [
      'Water bill is in, $48 each. Sent you the details',
      'Landlord is coming to look at the gutters Tuesday arvo, just a heads up',
      'Did you take my charger? Can\'t find it anywhere',
      'Making a curry tonight if you want some',
    ],
  },
  {
    id: 'jess',
    name: 'Jess',
    detail: 'Mobile',
    color: '#0288D1',
    seed: [
      { ago: 4 * D + 4 * H, from: 'them', text: 'Ok so for Mum\'s birthday I was thinking we go halves on the garden bench she keeps looking at?' },
      { ago: 4 * D + 3 * H + 20, from: 'me', text: 'Yeah good idea, the one from the garden centre?' },
      { ago: 4 * D + 3 * H + 18, from: 'them', text: 'That one. $340 so $170 each. I\'ll order it and you can pay me back' },
      { ago: 4 * D + 3 * H + 10, from: 'me', text: 'Sweet, transfer coming' },
      { ago: 4 * D + 3 * H + 2, from: 'them', text: 'Got it, thanks ❤️' },
      { ago: 6 * H, from: 'them', text: 'Bench arrives Friday. Can you help me get it in the car? Doesn\'t fit in mine' },
      { ago: 5 * H + 30, from: 'me', text: 'Yeah I can do Friday after 4' },
      { ago: 5 * H + 28, from: 'them', text: 'You\'re the best 🙌' },
    ],
    replies: [
      'Haha ok',
      'Yes!! Let\'s do it',
      'Can\'t talk now, call you tonight?',
      'Omg 😂',
      'Ok sounds good x',
      'Thanks for that x',
    ],
    idle: [
      'Have you seen the photos from the weekend? Mum looks so happy',
      'Coffee this week? I\'m free Wed or Thu',
      'What are you doing for the long weekend?',
      'Can you send me Aunty Carol\'s address again',
    ],
  },
  {
    id: 'liam',
    name: 'Liam Ng',
    detail: 'Mobile',
    color: '#388E3C',
    seed: [
      { ago: 8 * D + 5 * H, from: 'them', text: 'Ride Sunday? Thinking the coast loop, about 60k' },
      { ago: 8 * D + 4 * H + 30, from: 'me', text: 'Keen but I\'ve got a slow leak in the back tyre, need to sort that first' },
      { ago: 8 * D + 4 * H + 25, from: 'them', text: 'I\'ve got spare tubes, just bring it round' },
      { ago: 7 * D + 2 * H, from: 'me', text: 'Sorted the tyre, see you at the cafe 7:30' },
      { ago: 7 * D + 2 * H - 3, from: 'them', text: '💪' },
      { ago: 30 * H, from: 'them', text: 'Strava says you did 800m of climbing yesterday?? Where' },
      { ago: 29 * H + 15, from: 'me', text: 'Haha the hill road behind the reservoir. Brutal' },
      { ago: 29 * H + 12, from: 'them', text: 'Next time take me, need the training' },
    ],
    replies: [
      'Yeah nice',
      'Legs are wrecked haha',
      'Sweet, same time same place?',
      '👌',
      'Can\'t this weekend, in-laws are down',
      'Ha ok',
    ],
    idle: [
      'Cafe ride Saturday, 7:30 usual spot?',
      'New bike shop opened on the main road, decent prices on tyres',
      'Did you see the forecast, might have to bail on Sunday',
      'Got a PB on the hill today 🎉',
    ],
  },
  {
    id: 'plumber',
    name: 'Sam Whitfield Plumbing',
    detail: 'Business',
    color: '#455A64',
    seed: [
      { ago: 10 * D + 4 * H, from: 'me', text: 'Hi Sam, hot water cylinder is making a knocking noise and the pressure has dropped. Could you take a look?' },
      { ago: 10 * D + 3 * H + 20, from: 'them', text: 'Hi, sounds like the pressure valve. I can do Thursday morning between 8 and 10 if that suits' },
      { ago: 10 * D + 3 * H + 5, from: 'me', text: 'Thursday works, thanks' },
      { ago: 9 * D + 22 * H, from: 'them', text: 'Running about 20 min late sorry, there by 8:30' },
      { ago: 9 * D + 19 * H, from: 'them', text: 'All done, replaced the valve. Invoice will come through by email. Cheers' },
      { ago: 9 * D + 18 * H + 40, from: 'me', text: 'Great, thanks Sam' },
    ],
    replies: [
      'No problem, let me know if it plays up again',
      'I can fit you in next week, what days suit?',
      'Cheers, will be in touch',
      'Should be able to sort that. Send me a photo if you can',
    ],
    idle: [
      'Hi, just following up on the invoice from the other week. Let me know if you didn\'t get it. Cheers Sam',
    ],
  },
  {
    id: 'dental',
    name: 'Ridgeway Dental',
    detail: 'Business',
    color: '#00897B',
    automated: true,
    seed: [
      { ago: 12 * D, from: 'them', text: 'Ridgeway Dental: Reminder of your appointment on Tue at 2:15pm with Dr Chen. Reply Y to confirm or call 09 555 0142 to change.' },
      { ago: 12 * D - 30, from: 'me', text: 'Y' },
      { ago: 12 * D - 31, from: 'them', text: 'Thank you, your appointment is confirmed.' },
    ],
    replies: ['This number cannot receive replies. To change an appointment please call 09 555 0142.'],
    idle: ['Ridgeway Dental: Your 6-monthly check-up is due. Book online or call 09 555 0142.'],
  },
  {
    id: 'parcel',
    name: 'Parcel Tracking',
    detail: 'Notifications',
    color: '#F9A825',
    automated: true,
    seed: [
      { ago: 2 * D + 8 * H, from: 'them', text: 'Your parcel AB4471902NZ is on its way and should arrive tomorrow. Track: nzparcel.example/t/AB4471902' },
      { ago: D + 5 * H, from: 'them', text: 'Your parcel AB4471902NZ has been delivered and left in a safe place. Thanks for using our service.' },
    ],
    replies: [],
    idle: ['A parcel addressed to you is being processed and will be delivered within 2 working days.'],
  },
];

export function contactById(id: string): DecoyContact | undefined {
  return CONTACTS.find((c) => c.id === id);
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
