/**
 * Tactics scenarios: a match situation, three or four choices, and why each is good or bad.
 * Points: 2 = the best choice, 1 = reasonable but weaker, 0 = a poor choice. Kept on the server so
 * the browser only learns the answer after choosing.
 *
 * Pitch coordinates: x 0 (left touchline) to 100; y 0 is the goal your team attacks, 100 your own.
 * Content is in English and Arabic; other languages fall back to English.
 */
import type { z } from 'zod';
import type { PlayArrow, PlayTopic, PitchPlayer, PitchPoint } from '@fp/contracts';
import type { Bi } from '@fp/domain';

type Pt = z.input<typeof PitchPoint>;
type Player = z.input<typeof PitchPlayer>;

export interface ScenarioOption {
  id: string;
  label: Bi;
  arrow: z.input<typeof PlayArrow> | null;
  points: 0 | 1 | 2;
  why: Bi;
}

export interface Scenario {
  id: string;
  topic: z.input<typeof PlayTopic>;
  prompt: Bi;
  pitch: { you: Player; ball: Pt; teammates: Player[]; opponents: Player[] };
  options: ScenarioOption[];
  lesson: Bi;
}

const p = (x: number, y: number, n?: string): Player => (n ? { x, y, n } : { x, y });
const arrow = (kind: z.input<typeof PlayArrow>['kind'], from: Pt, to: Pt) => ({ kind, from, to });

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'find-free-man',
    topic: 'passing',
    prompt: {
      en: 'You receive in midfield and a defender steps up to press you. Your striker is tightly marked. What do you do?',
      ar: 'تستلم الكرة في الوسط ويتقدم مدافع للضغط عليك. المهاجم مراقَب بشدة. ماذا تفعل؟',
    },
    pitch: {
      you: p(50, 46), ball: p(50, 45),
      teammates: [p(84, 30, '7'), p(50, 20, '9'), p(34, 50, '8'), p(18, 34, '11')],
      opponents: [p(50, 39), p(50, 16), p(42, 26), p(60, 28), p(66, 44), p(30, 42)],
    },
    options: [
      { id: 'a', label: { en: 'Pass wide to 7', ar: 'مرر إلى 7 على الطرف' }, arrow: arrow('pass', p(50, 45), p(84, 30)), points: 2,
        why: { en: '7 is free with space to run into. One pass takes the presser and two midfielders out of the game.', ar: 'اللاعب 7 حر ولديه مساحة للتقدم. تمريرة واحدة تُخرج الضاغط ولاعبَي وسط من اللعب.' } },
      { id: 'b', label: { en: 'Force it into 9', ar: 'مرر إلى 9 رغم الرقابة' }, arrow: arrow('pass', p(50, 45), p(50, 20)), points: 0,
        why: { en: 'The centre-back is touch-tight on 9 and two midfielders cover the lane. Likely intercepted.', ar: 'قلب الدفاع ملاصق للاعب 9 ولاعبا الوسط يغلقان الممر. على الأرجح ستُقطع.' } },
      { id: 'c', label: { en: 'Dribble at the presser', ar: 'راوغ اللاعب الضاغط' }, arrow: arrow('dribble', p(50, 45), p(50, 34)), points: 0,
        why: { en: 'You run into the pressure where the opponents have numbers. Losing it here starts their counter.', ar: 'تجري نحو الضغط حيث يتفوق الخصم عددياً. فقدان الكرة هنا يبدأ هجمتهم المرتدة.' } },
      { id: 'd', label: { en: 'Lay it back to 8', ar: 'أعِدها إلى 8' }, arrow: arrow('pass', p(50, 45), p(34, 50)), points: 1,
        why: { en: 'Safe, and you keep the ball, but play stays in the crowded middle and the chance to break the line is gone.', ar: 'خيار آمن وتحافظ على الكرة، لكن اللعب يبقى في الوسط المزدحم وتضيع فرصة كسر الخط.' } },
    ],
    lesson: { en: 'Scan before you receive. The best pass is often to the free player you saw before the ball arrived.', ar: 'انظر حولك قبل الاستلام. أفضل تمريرة غالباً للاعب الحر الذي رأيته قبل وصول الكرة.' },
  },
  {
    id: 'square-it',
    topic: 'shooting',
    prompt: {
      en: 'You are in the box. A defender blocks your shooting angle and the keeper is set. 11 is free at the far post.',
      ar: 'أنت داخل المنطقة. مدافع يغلق زاوية تسديدك والحارس متمركز. اللاعب 11 حر عند القائم البعيد.',
    },
    pitch: {
      you: p(38, 14), ball: p(39, 13),
      teammates: [p(64, 8, '11'), p(50, 30, '10')],
      opponents: [p(50, 3), p(43, 9), p(56, 16), p(30, 22)],
    },
    options: [
      { id: 'a', label: { en: 'Shoot at the near post', ar: 'سدد نحو القائم القريب' }, arrow: arrow('shot', p(39, 13), p(45, 0)), points: 0,
        why: { en: 'The defender is in the way and the keeper covers the near post. Low chance, likely blocked.', ar: 'المدافع في طريق الكرة والحارس يغطي القائم القريب. فرصة ضعيفة وعلى الأرجح ستُصد.' } },
      { id: 'b', label: { en: 'Square it to 11', ar: 'مرر عرضية أرضية إلى 11' }, arrow: arrow('pass', p(39, 13), p(64, 8)), points: 2,
        why: { en: '11 has an open goal once the keeper is on your side. The best chance belongs to the team, not to you.', ar: 'سيجد 11 المرمى مفتوحاً لأن الحارس في جهتك. أفضل فرصة هي للفريق وليست لك وحدك.' } },
      { id: 'c', label: { en: 'Take a touch, shoot far corner', ar: 'خذ لمسة وسدد نحو الزاوية البعيدة' }, arrow: arrow('dribble', p(39, 13), p(42, 16)), points: 1,
        why: { en: 'It can work, but the extra touch lets the defender recover and the keeper reset.', ar: 'قد تنجح، لكن اللمسة الإضافية تمنح المدافع وقتاً للعودة والحارس وقتاً للتمركز.' } },
    ],
    lesson: { en: 'Before you shoot, check whether a teammate has a clearer chance. A simple pass often scores more than a hard shot.', ar: 'قبل التسديد، تأكد إن كان لزميلك فرصة أوضح. التمريرة البسيطة تسجل غالباً أكثر من التسديدة القوية.' },
  },
  {
    id: 'shoot-early',
    topic: 'shooting',
    prompt: {
      en: 'You receive at the edge of the box with a clear sight of goal. A defender is closing from behind.',
      ar: 'تستلم على حافة المنطقة ولديك رؤية واضحة للمرمى. مدافع يقترب منك من الخلف.',
    },
    pitch: {
      you: p(50, 18), ball: p(50, 17),
      teammates: [p(80, 22, '7'), p(30, 30, '8')],
      opponents: [p(50, 3), p(55, 23), p(76, 19), p(38, 10)],
    },
    options: [
      { id: 'a', label: { en: 'Shoot first time, low to the corner', ar: 'سدد مباشرة، كرة أرضية نحو الزاوية' }, arrow: arrow('shot', p(50, 17), p(57, 0)), points: 2,
        why: { en: 'Clear sight, central, before the defender arrives: this is the chance. Low shots to the corner are hardest to save.', ar: 'رؤية واضحة ومن العمق وقبل وصول المدافع: هذه هي الفرصة. التسديدات الأرضية نحو الزاوية هي الأصعب على الحارس.' } },
      { id: 'b', label: { en: 'Pass wide to 7', ar: 'مرر إلى 7 على الطرف' }, arrow: arrow('pass', p(50, 17), p(80, 22)), points: 0,
        why: { en: '7 is marked and further from goal. You give away a better chance than the one you create.', ar: 'اللاعب 7 مراقَب وأبعد عن المرمى. تضيّع فرصة أفضل من التي تصنعها.' } },
      { id: 'c', label: { en: 'Take a touch to set yourself', ar: 'خذ لمسة لتجهز نفسك' }, arrow: arrow('dribble', p(50, 17), p(48, 14)), points: 1,
        why: { en: 'A better-set shot, but the defender behind you will likely block or tackle by then.', ar: 'تسديدة أكثر توازناً، لكن المدافع خلفك سيصدها أو يقطعها غالباً قبل ذلك.' } },
    ],
    lesson: { en: 'Chances in central areas close fast. When you have a clear sight of goal, shoot early and low.', ar: 'الفرص في العمق تُغلق بسرعة. عندما ترى المرمى بوضوح، سدد مبكراً وبكرة أرضية.' },
  },
  {
    id: 'two-v-one',
    topic: 'transition',
    prompt: {
      en: 'Counter-attack: you carry the ball, 9 runs beside you, and only one defender is back.',
      ar: 'هجمة مرتدة: تتقدم بالكرة، واللاعب 9 يركض بجانبك، ولم يعد سوى مدافع واحد.',
    },
    pitch: {
      you: p(42, 42), ball: p(42, 40),
      teammates: [p(66, 38, '9')],
      opponents: [p(54, 28), p(50, 4), p(48, 70), p(30, 64)],
    },
    options: [
      { id: 'a', label: { en: 'Drive at the defender, then release 9', ar: 'تقدم نحو المدافع ثم مرر إلى 9' }, arrow: arrow('dribble', p(42, 40), p(50, 31)), points: 2,
        why: { en: 'Making the defender commit to you leaves 9 free. Release the pass the moment he steps toward you.', ar: 'عندما تجبر المدافع على التقدم نحوك يصبح 9 حراً. مرر لحظة تقدمه إليك.' } },
      { id: 'b', label: { en: 'Pass to 9 straight away', ar: 'مرر إلى 9 فوراً' }, arrow: arrow('pass', p(42, 40), p(66, 38)), points: 1,
        why: { en: 'Not bad, but the defender can simply shift across to 9 and it becomes a 1v1.', ar: 'ليس سيئاً، لكن المدافع يستطيع الانتقال نحو 9 فتصبح المواجهة فردية.' } },
      { id: 'c', label: { en: 'Shoot from distance', ar: 'سدد من بعيد' }, arrow: arrow('shot', p(42, 40), p(48, 0)), points: 0,
        why: { en: 'Forty metres out with a 2v1 on: you waste the best situation in football.', ar: 'من أربعين متراً وأنتما اثنان ضد واحد: تُضيع أفضل موقف في كرة القدم.' } },
      { id: 'd', label: { en: 'Slow down and wait for support', ar: 'أبطئ وانتظر المساندة' }, arrow: null, points: 0,
        why: { en: 'Their recovering players get back and the counter is over.', ar: 'يعود لاعبو الخصم إلى مواقعهم وتنتهي الهجمة المرتدة.' } },
    ],
    lesson: { en: 'In a 2v1, attack the defender to make him choose, then pass to whoever he leaves.', ar: 'في موقف اثنين ضد واحد، هاجم المدافع لتجبره على الاختيار، ثم مرر لمن يتركه.' },
  },
  {
    id: 'jockey-wide',
    topic: 'defending',
    prompt: {
      en: 'You are defending. A winger runs at you near the touchline. You are goal-side with no cover yet.',
      ar: 'أنت تدافع. جناح يتقدم نحوك قرب خط التماس. أنت بينه وبين المرمى ولا يوجد زميل يغطيك بعد.',
    },
    pitch: {
      you: p(76, 72), ball: p(84, 64),
      teammates: [p(55, 85, '5'), p(44, 80, '4')],
      opponents: [p(84, 65), p(52, 74), p(62, 60)],
    },
    options: [
      { id: 'a', label: { en: 'Dive in for the tackle', ar: 'انقض لاستخلاص الكرة' }, arrow: arrow('run', p(76, 72), p(84, 65)), points: 0,
        why: { en: 'If you miss, he is through with nobody behind you. Never dive in without cover.', ar: 'إن أخطأت، سيمر ولا أحد خلفك. لا تنقض أبداً دون تغطية.' } },
      { id: 'b', label: { en: 'Jockey and show him down the line', ar: 'تراجع بتوازن ووجّهه نحو خط التماس' }, arrow: arrow('run', p(76, 72), p(80, 74)), points: 2,
        why: { en: 'Staying on your feet and showing him outside keeps him away from goal and buys time for cover.', ar: 'البقاء على قدميك وتوجيهه للخارج يبعده عن المرمى ويكسب وقتاً لوصول التغطية.' } },
      { id: 'c', label: { en: 'Show him inside', ar: 'وجّهه نحو الداخل' }, arrow: arrow('run', p(76, 72), p(82, 70)), points: 0,
        why: { en: 'Inside is towards goal and his teammates. That is where he can hurt you most.', ar: 'الداخل يعني نحو المرمى وزملائه. هناك يستطيع إيذاءكم أكثر.' } },
      { id: 'd', label: { en: 'Drop back to the box', ar: 'ارجع إلى منطقة الجزاء' }, arrow: arrow('run', p(76, 72), p(70, 86)), points: 1,
        why: { en: 'Safe from being beaten, but he gets a free cross from a good position.', ar: 'تتجنب أن يتخطاك، لكنه يحصل على عرضية حرة من موقع جيد.' } },
    ],
    lesson: { en: 'Defending 1v1: stay on your feet, stay goal-side, and show the attacker away from goal until help arrives.', ar: 'في الدفاع الفردي: ابقَ على قدميك وبين المهاجم والمرمى، ووجّهه بعيداً عن المرمى حتى تصل المساعدة.' },
  },
  {
    id: 'press-trigger',
    topic: 'defending',
    prompt: {
      en: 'You are the striker. Their centre-back takes a heavy touch facing his own goal. Their other centre-back is to his left.',
      ar: 'أنت المهاجم. قلب دفاع الخصم يستلم الكرة بلمسة ثقيلة ووجهه نحو مرماه. زميله الآخر على يساره.',
    },
    pitch: {
      you: p(52, 28), ball: p(44, 16),
      teammates: [p(80, 30, '7'), p(22, 32, '11'), p(50, 45, '10')],
      opponents: [p(44, 15), p(22, 14), p(50, 3), p(78, 18)],
    },
    options: [
      { id: 'a', label: { en: 'Press now, curving to block the pass left', ar: 'اضغط الآن بمسار منحنٍ يغلق التمرير لليسار' }, arrow: arrow('run', p(52, 28), p(38, 18)), points: 2,
        why: { en: 'A heavy touch is a pressing trigger. Curving your run cuts off the easy pass, so he must go long or lose it.', ar: 'اللمسة الثقيلة إشارة للضغط. مسارك المنحني يقطع التمريرة السهلة، فإما أن يلعب طويلة أو يفقد الكرة.' } },
      { id: 'b', label: { en: 'Sprint straight at him', ar: 'اركض نحوه مباشرة' }, arrow: arrow('run', p(52, 28), p(45, 17)), points: 1,
        why: { en: 'Right moment, wrong angle: he can pass to the other centre-back around you.', ar: 'التوقيت صحيح والزاوية خاطئة: يستطيع التمرير لزميله من حولك.' } },
      { id: 'c', label: { en: 'Hold your position', ar: 'ابقَ في مكانك' }, arrow: null, points: 0,
        why: { en: 'You give him time to fix the touch and build the attack calmly.', ar: 'تمنحه وقتاً لتصحيح اللمسة وبناء الهجمة بهدوء.' } },
    ],
    lesson: { en: 'Press on triggers (a heavy touch, a player facing his goal, a slow pass) and angle your run to cut the next pass.', ar: 'اضغط عند الإشارات (لمسة ثقيلة، لاعب وجهه لمرماه، تمريرة بطيئة) واجعل مسارك يقطع التمريرة التالية.' },
  },
  {
    id: 'switch-play',
    topic: 'passing',
    prompt: {
      en: 'You are the left-back. Three opponents crowd the left side. 2 is completely free on the far side.',
      ar: 'أنت الظهير الأيسر. ثلاثة لاعبين من الخصم يزدحمون في الجهة اليسرى. اللاعب 2 حر تماماً في الجهة البعيدة.',
    },
    pitch: {
      you: p(14, 56), ball: p(15, 55),
      teammates: [p(18, 38, '11'), p(36, 52, '8'), p(88, 46, '2'), p(50, 72, '5')],
      opponents: [p(20, 44), p(26, 52), p(16, 32), p(40, 44), p(60, 40)],
    },
    options: [
      { id: 'a', label: { en: 'Switch it long to 2', ar: 'حوّل اللعب بتمريرة طويلة إلى 2' }, arrow: arrow('pass', p(15, 55), p(88, 46)), points: 2,
        why: { en: 'They have shifted to your side. Switching finds 2 with time and space to attack.', ar: 'انتقل الخصم إلى جهتك. تحويل اللعب يجد اللاعب 2 بوقت ومساحة للهجوم.' } },
      { id: 'b', label: { en: 'Pass short to 11', ar: 'مرر قصيرة إلى 11' }, arrow: arrow('pass', p(15, 55), p(18, 38)), points: 0,
        why: { en: '11 is surrounded. The pass invites the press and you could lose it near your own goal.', ar: 'اللاعب 11 محاصر. هذه التمريرة تستدعي الضغط وقد تفقد الكرة قرب مرماك.' } },
      { id: 'c', label: { en: 'Back to the centre-back', ar: 'أعِدها إلى قلب الدفاع' }, arrow: arrow('pass', p(15, 55), p(50, 72)), points: 1,
        why: { en: 'Keeps the ball and can lead to a switch, but slower. The space on the far side may close.', ar: 'تحافظ على الكرة وقد تقود إلى تحويل اللعب، لكن ببطء. قد تُغلق المساحة في الجهة البعيدة.' } },
      { id: 'd', label: { en: 'Dribble out of trouble', ar: 'راوغ للخروج من الضغط' }, arrow: arrow('dribble', p(15, 55), p(24, 48)), points: 0,
        why: { en: 'You run into the crowd you are trying to escape.', ar: 'تجري نحو الزحام الذي تحاول الهروب منه.' } },
    ],
    lesson: { en: 'When one side is overloaded, the space is on the other side. Switch play quickly.', ar: 'عندما تزدحم جهة، تكون المساحة في الجهة الأخرى. حوّل اللعب بسرعة.' },
  },
  {
    id: 'find-the-gap',
    topic: 'positioning',
    prompt: {
      en: 'Your centre-back has the ball. You are the midfielder, with a marker right behind you. Where do you move to receive?',
      ar: 'قلب دفاعك يملك الكرة. أنت لاعب الوسط ومراقبك خلفك مباشرة. إلى أين تتحرك لتستلم؟',
    },
    pitch: {
      you: p(50, 62), ball: p(48, 80),
      teammates: [p(48, 81, '4'), p(85, 60, '2'), p(15, 60, '3')],
      opponents: [p(50, 57), p(34, 52), p(66, 52), p(50, 40)],
    },
    options: [
      { id: 'a', label: { en: 'Stay where you are', ar: 'ابقَ في مكانك' }, arrow: null, points: 0,
        why: { en: 'Your marker is between you and goal. A pass to you can only go backwards or be intercepted.', ar: 'مراقبك بينك وبين المرمى. التمريرة لك لن تكون إلا للخلف أو ستُقطع.' } },
      { id: 'b', label: { en: 'Move into the gap, body open', ar: 'تحرك إلى الفراغ وجسمك مفتوح' }, arrow: arrow('run', p(50, 62), p(60, 64)), points: 2,
        why: { en: 'Between two opponents, side-on, you can receive and turn forward in one touch.', ar: 'بين لاعبين من الخصم وبوضعية جانبية، تستطيع الاستلام والالتفاف للأمام بلمسة واحدة.' } },
      { id: 'c', label: { en: 'Drop right next to the centre-back', ar: 'انزل بجانب قلب الدفاع' }, arrow: arrow('run', p(50, 62), p(40, 77)), points: 1,
        why: { en: 'You get the ball safely but you are now in front of everyone and add nothing going forward.', ar: 'تستلم بأمان لكنك الآن أمام الجميع ولا تضيف شيئاً للهجوم.' } },
      { id: 'd', label: { en: 'Run long behind their midfield', ar: 'اركض طويلاً خلف وسط الخصم' }, arrow: arrow('run', p(50, 62), p(50, 36)), points: 0,
        why: { en: 'The centre-back has no safe pass to you there, and you leave the middle empty.', ar: 'لا يملك قلب الدفاع تمريرة آمنة لك هناك، وتترك الوسط فارغاً.' } },
    ],
    lesson: { en: 'Get away from your marker into the gaps between opponents, and open your body so you can play forward.', ar: 'ابتعد عن مراقبك نحو الفراغات بين لاعبي الخصم، وافتح جسمك لتلعب للأمام.' },
  },
  {
    id: 'cutback',
    topic: 'passing',
    prompt: {
      en: 'You beat your man and reach the byline. 9 is at the near post with two markers. 8 is arriving at the penalty spot.',
      ar: 'تخطيت مدافعك ووصلت إلى خط المرمى. اللاعب 9 عند القائم القريب مع مدافعَين. اللاعب 8 قادم نحو نقطة الجزاء.',
    },
    pitch: {
      you: p(86, 6), ball: p(87, 5),
      teammates: [p(58, 6, '9'), p(52, 18, '8')],
      opponents: [p(56, 4), p(61, 8), p(50, 2), p(76, 12)],
    },
    options: [
      { id: 'a', label: { en: 'High cross to the back post', ar: 'عرضية عالية للقائم البعيد' }, arrow: arrow('pass', p(87, 5), p(38, 6)), points: 0,
        why: { en: 'Nobody is there. The keeper or defenders will collect it.', ar: 'لا أحد هناك. سيلتقطها الحارس أو المدافعون.' } },
      { id: 'b', label: { en: 'Drive it to 9 at the near post', ar: 'مرر قوية إلى 9 عند القائم القريب' }, arrow: arrow('pass', p(87, 5), p(58, 6)), points: 1,
        why: { en: 'Sometimes it works, but 9 is outnumbered two to one.', ar: 'قد تنجح أحياناً، لكن 9 محاصر بمدافعَين.' } },
      { id: 'c', label: { en: 'Cut it back to 8', ar: 'أعِدها للخلف إلى 8' }, arrow: arrow('pass', p(87, 5), p(52, 18)), points: 2,
        why: { en: 'Defenders are running towards their own goal; 8 arrives facing it with time. Cutbacks create the clearest chances.', ar: 'المدافعون يركضون نحو مرماهم، و8 يصل ووجهه للمرمى ولديه وقت. الكرات المرتدة للخلف تصنع أوضح الفرص.' } },
      { id: 'd', label: { en: 'Shoot from the tight angle', ar: 'سدد من الزاوية الضيقة' }, arrow: arrow('shot', p(87, 5), p(56, 0)), points: 0,
        why: { en: 'Almost no goal to aim at. The keeper only has to stand at his post.', ar: 'لا يكاد يوجد مرمى للتصويب. يكفي الحارس أن يقف عند قائمه.' } },
    ],
    lesson: { en: 'From the byline, look back to the arriving runner: he faces the goal while the defenders face their own net.', ar: 'من خط المرمى، انظر للخلف نحو الزميل القادم: هو يواجه المرمى والمدافعون يواجهون شباكهم.' },
  },
  {
    id: 'take-him-on',
    topic: 'dribbling',
    prompt: {
      en: 'You are the winger, 1v1 with their full-back. There is space behind him and no defender covering.',
      ar: 'أنت الجناح، في مواجهة فردية مع ظهير الخصم. توجد مساحة خلفه ولا مدافع يغطيه.',
    },
    pitch: {
      you: p(84, 30), ball: p(84, 29),
      teammates: [p(50, 18, '9'), p(60, 45, '8')],
      opponents: [p(82, 22), p(52, 14), p(46, 10), p(58, 34), p(50, 3)],
    },
    options: [
      { id: 'a', label: { en: 'Take him on towards the byline', ar: 'راوغه نحو خط المرمى' }, arrow: arrow('dribble', p(84, 29), p(88, 12)), points: 2,
        why: { en: 'Isolated, with space behind and no cover: this is the moment for a winger to attack.', ar: 'مواجهة معزولة مع مساحة خلفه ودون تغطية: هذه لحظة الجناح للهجوم.' } },
      { id: 'b', label: { en: 'Pass back to 8', ar: 'أعِدها إلى 8' }, arrow: arrow('pass', p(84, 29), p(60, 45)), points: 1,
        why: { en: 'You keep the ball, but you give up a 1v1 that the team worked to create.', ar: 'تحافظ على الكرة، لكنك تتخلى عن مواجهة فردية عمل الفريق على صنعها.' } },
      { id: 'c', label: { en: 'Early cross from deep', ar: 'عرضية مبكرة من العمق' }, arrow: arrow('pass', p(84, 29), p(52, 12)), points: 0,
        why: { en: 'Two centre-backs against one striker. The cross is easy to defend.', ar: 'قلبا دفاع ضد مهاجم واحد. العرضية سهلة الإبعاد.' } },
    ],
    lesson: { en: 'Dribble when you are isolated 1v1 in the final third with space behind. Pass when the dribble runs into numbers.', ar: 'راوغ عندما تكون في مواجهة فردية في الثلث الأخير مع مساحة خلف المدافع. مرر عندما تقود المراوغة إلى زحام.' },
  },
  {
    id: 'own-third',
    topic: 'dribbling',
    prompt: {
      en: 'You are the centre-back with the ball near your own box. Their striker is pressing you. Your left-back is free.',
      ar: 'أنت قلب الدفاع ومعك الكرة قرب منطقتك. مهاجم الخصم يضغط عليك. ظهيرك الأيسر حر.',
    },
    pitch: {
      you: p(40, 86), ball: p(40, 85),
      teammates: [p(50, 97, '1'), p(12, 78, '3'), p(66, 86, '5'), p(48, 66, '6')],
      opponents: [p(42, 80), p(66, 76), p(50, 62)],
    },
    options: [
      { id: 'a', label: { en: 'Dribble past the striker', ar: 'راوغ المهاجم' }, arrow: arrow('dribble', p(40, 85), p(36, 74)), points: 0,
        why: { en: 'If it goes wrong, he is through on goal. The reward is small, the risk is a goal.', ar: 'إن فشلت، سينفرد بالمرمى. المكسب صغير والخطر هدف.' } },
      { id: 'b', label: { en: 'Pass to the free left-back', ar: 'مرر إلى الظهير الأيسر الحر' }, arrow: arrow('pass', p(40, 85), p(12, 78)), points: 2,
        why: { en: 'Simple and safe, and it moves the ball away from the press to a player facing forward.', ar: 'بسيطة وآمنة، وتنقل الكرة بعيداً عن الضغط إلى لاعب وجهه للأمام.' } },
      { id: 'c', label: { en: 'Back to the goalkeeper', ar: 'أعِدها إلى الحارس' }, arrow: arrow('pass', p(40, 85), p(50, 97)), points: 1,
        why: { en: 'Safe, but the striker can follow it and press the keeper.', ar: 'آمنة، لكن المهاجم قد يتبعها ويضغط على الحارس.' } },
    ],
    lesson: { en: 'In your own third, take no risks with the ball. Find the free player, or clear it.', ar: 'في ثلثك الدفاعي، لا تخاطر بالكرة. ابحث عن اللاعب الحر أو أبعدها.' },
  },
  {
    id: 'counter-press',
    topic: 'transition',
    prompt: {
      en: 'Your team just lost the ball. The opponent who won it is right next to you, facing his own goal.',
      ar: 'فقد فريقك الكرة للتو. لاعب الخصم الذي استخلصها بجانبك مباشرة ووجهه نحو مرماه.',
    },
    pitch: {
      you: p(54, 38), ball: p(50, 43),
      teammates: [p(40, 40, '8'), p(70, 30, '7'), p(50, 70, '4')],
      opponents: [p(50, 44), p(30, 58), p(72, 56), p(50, 60)],
    },
    options: [
      { id: 'a', label: { en: 'Press him immediately', ar: 'اضغط عليه فوراً' }, arrow: arrow('run', p(54, 38), p(51, 42)), points: 2,
        why: { en: 'He has his back to play and no time. Winning it back now catches their team spread out to attack.', ar: 'ظهره للعب ولا وقت لديه. استعادة الكرة الآن تجد فريقه منتشراً للهجوم.' } },
      { id: 'b', label: { en: 'Jog back into position', ar: 'ارجع إلى مركزك بهدوء' }, arrow: arrow('run', p(54, 38), p(54, 60)), points: 0,
        why: { en: 'You give him time to turn and start the counter-attack.', ar: 'تمنحه وقتاً للالتفاف وبدء الهجمة المرتدة.' } },
      { id: 'c', label: { en: 'Cut off the pass to his winger', ar: 'اقطع التمريرة نحو جناحه' }, arrow: arrow('run', p(54, 38), p(62, 50)), points: 1,
        why: { en: 'Useful if a teammate presses him, but alone it leaves him free to turn.', ar: 'مفيد إن ضغط عليه زميلك، لكن وحدك يتركه حراً للالتفاف.' } },
    ],
    lesson: { en: 'The first seconds after losing the ball are the best time to win it back. The nearest player presses at once.', ar: 'الثواني الأولى بعد فقدان الكرة هي أفضل وقت لاستعادتها. أقرب لاعب يضغط فوراً.' },
  },
  {
    id: 'overlap',
    topic: 'positioning',
    prompt: {
      en: 'You are the left-back. Your winger 11 has the ball facing their full-back. What run do you make?',
      ar: 'أنت الظهير الأيسر. الجناح 11 يملك الكرة في مواجهة ظهير الخصم. أي تحرك تقوم به؟',
    },
    pitch: {
      you: p(14, 58), ball: p(18, 36),
      teammates: [p(18, 37, '11'), p(46, 22, '9'), p(38, 50, '8')],
      opponents: [p(20, 28), p(44, 16), p(36, 38), p(58, 20)],
    },
    options: [
      { id: 'a', label: { en: 'Overlap outside him', ar: 'تقدم من خلفه على الخط الخارجي' }, arrow: arrow('run', p(14, 58), p(8, 24)), points: 2,
        why: { en: 'Now it is 2v1 against their full-back: he must choose, and 11 can go inside or release you.', ar: 'تصبح اثنين ضد واحد أمام ظهيرهم: عليه أن يختار، و11 يستطيع الدخول للعمق أو التمرير لك.' } },
      { id: 'b', label: { en: 'Stay back', ar: 'ابقَ في الخلف' }, arrow: null, points: 1,
        why: { en: 'Safe against a counter, but 11 is left alone against his man.', ar: 'آمن ضد المرتدة، لكن 11 يُترك وحيداً أمام مدافعه.' } },
      { id: 'c', label: { en: 'Run inside, right next to 11', ar: 'اركض للداخل بجانب 11 مباشرة' }, arrow: arrow('run', p(14, 58), p(22, 40)), points: 0,
        why: { en: 'You bring your own marker into his space. Now two of you share one small area.', ar: 'تجلب مراقبك إلى مساحته. الآن أنتما الاثنان في مساحة صغيرة واحدة.' } },
    ],
    lesson: { en: 'Create 2v1s out wide: an overlapping run forces the defender to choose between two players.', ar: 'اصنع مواقف اثنين ضد واحد على الطرف: التقدم من الخلف يجبر المدافع على الاختيار بين لاعبين.' },
  },
  {
    id: 'low-block',
    topic: 'passing',
    prompt: {
      en: 'The opponents defend deep with ten players behind the ball. You have it 35 metres from goal and no clear lane.',
      ar: 'يدافع الخصم بعمق بعشرة لاعبين خلف الكرة. معك الكرة على بعد 35 متراً من المرمى ولا يوجد ممر واضح.',
    },
    pitch: {
      you: p(50, 40), ball: p(50, 39),
      teammates: [p(20, 30, '11'), p(82, 30, '7'), p(50, 18, '9'), p(30, 46, '8'), p(70, 46, '6')],
      opponents: [p(30, 26), p(42, 24), p(58, 24), p(70, 26), p(36, 14), p(50, 12), p(64, 14), p(50, 30), p(40, 32), p(60, 32)],
    },
    options: [
      { id: 'a', label: { en: 'Shoot from distance', ar: 'سدد من بعيد' }, arrow: arrow('shot', p(50, 39), p(50, 0)), points: 0,
        why: { en: 'Through a wall of bodies from 35 metres. It hands them the ball back.', ar: 'عبر جدار من اللاعبين ومن 35 متراً. تعيد لهم الكرة.' } },
      { id: 'b', label: { en: 'Force a pass into 9', ar: 'مرر بالقوة إلى 9' }, arrow: arrow('pass', p(50, 39), p(50, 18)), points: 0,
        why: { en: 'There is no lane. They want you to try this so they can win it and counter.', ar: 'لا يوجد ممر. هم يريدونك أن تحاول ذلك ليستخلصوا الكرة ويهاجموا بمرتدة.' } },
      { id: 'c', label: { en: 'Move it quickly to 6, then wide', ar: 'مرر سريعاً إلى 6 ثم للطرف' }, arrow: arrow('pass', p(50, 39), p(70, 46)), points: 2,
        why: { en: 'Quick circulation makes the block shift. Gaps open when defenders move, not when they stand still.', ar: 'تدوير الكرة بسرعة يجبر الكتلة الدفاعية على التحرك. الفراغات تُفتح عندما يتحرك المدافعون لا عندما يقفون.' } },
      { id: 'd', label: { en: 'Dribble into the middle', ar: 'راوغ نحو العمق' }, arrow: arrow('dribble', p(50, 39), p(50, 31)), points: 1,
        why: { en: 'It can drag a player out, but you will soon be surrounded.', ar: 'قد يسحب لاعباً من مكانه، لكنك ستُحاصر قريباً.' } },
    ],
    lesson: { en: 'Against a deep block, be patient: move the ball fast from side to side until a gap opens.', ar: 'أمام الدفاع المتكتل، اصبر: حرك الكرة بسرعة من جهة لأخرى حتى يُفتح فراغ.' },
  },
  {
    id: 'defend-cross',
    topic: 'defending',
    prompt: {
      en: 'You are the centre-back. A cross is coming from the right and their striker is next to you.',
      ar: 'أنت قلب الدفاع. عرضية قادمة من اليمين ومهاجم الخصم بجانبك.',
    },
    pitch: {
      you: p(46, 88), ball: p(86, 80),
      teammates: [p(58, 90, '5'), p(30, 86, '3'), p(50, 98, '1')],
      opponents: [p(86, 80), p(50, 86), p(62, 76)],
    },
    options: [
      { id: 'a', label: { en: 'Watch only the ball', ar: 'راقب الكرة فقط' }, arrow: null, points: 0,
        why: { en: 'The striker drifts off your shoulder unseen and attacks the cross free.', ar: 'ينسلّ المهاجم من خلف كتفك دون أن تراه ويهاجم العرضية حراً.' } },
      { id: 'b', label: { en: 'Goal-side, touch-tight, see ball and man', ar: 'بينه وبين المرمى، ملاصقاً له، ترى الكرة واللاعب' }, arrow: arrow('run', p(46, 88), p(49, 89)), points: 2,
        why: { en: 'You can attack the ball first and still feel where he is. He has to go through you.', ar: 'تستطيع الوصول للكرة أولاً مع الإحساس بمكانه. عليه أن يتجاوزك.' } },
      { id: 'c', label: { en: 'Step up to catch him offside', ar: 'تقدم لإيقاعه في التسلل' }, arrow: arrow('run', p(46, 88), p(46, 78)), points: 1,
        why: { en: 'Possible if the whole line steps together, but alone it leaves him onside and free.', ar: 'ممكن إن تقدم خط الدفاع كله معاً، لكن وحدك تتركه في وضع سليم وحراً.' } },
    ],
    lesson: { en: 'Defending crosses: stay between the striker and your goal, close enough to touch, with the ball and the man both in view.', ar: 'في الدفاع ضد العرضيات: ابقَ بين المهاجم ومرماك، قريباً بما يكفي لتلمسه، والكرة واللاعب في مجال رؤيتك.' },
  },
];

const BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));
export const scenarioById = (id: string) => BY_ID.get(id);

/** A random, non-repeating draw of `n` scenario ids. */
export function drawScenarioIds(n: number, random: () => number = Math.random): string[] {
  const ids = SCENARIOS.map((s) => s.id);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids.slice(0, Math.min(n, ids.length));
}

/** What the browser sees before answering: no points, no explanations. */
export function publicScenario(s: Scenario) {
  return { id: s.id, topic: s.topic, prompt: s.prompt, pitch: s.pitch, options: s.options.map((o) => ({ id: o.id, label: o.label, arrow: o.arrow })) };
}

export function bestOption(s: Scenario): ScenarioOption {
  return s.options.reduce((a, b) => (b.points > a.points ? b : a));
}
