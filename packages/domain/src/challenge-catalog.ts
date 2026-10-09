/**
 * The starter catalog: twelve challenge templates. Admins install them once (idempotent, by slug)
 * as draft templates, then create real challenges from them and edit anything without a deploy.
 * Every instruction is doable on a pitch, in a park or a garden with a ball and a few markers:
 * no heights, roads, traffic, private property or stunts.
 */
import type { AgeBand } from './age.js';
import type { ChallengeCategory, ChallengeDifficulty, ChallengeFormat } from './challenge-rules.js';
import type { Rubric } from './challenge-rubric.js';
import type { Bi } from './play.js';

export interface ChallengeRecording {
  camera: 'side' | 'front' | 'behind' | 'any';
  orientation: 'vertical' | 'horizontal' | 'any';
  continuousTake: boolean;
  notes?: Bi;
}

export interface ChallengeRuleText {
  kind: 'eligibility' | 'disqualification' | 'safety' | 'recording' | 'general';
  body: Bi;
}

export interface ChallengeTemplate {
  slug: string;
  templateKey: string;
  format: ChallengeFormat;
  category: ChallengeCategory;
  difficulty: ChallengeDifficulty;
  skillKey: string | null;
  hashtag: string;
  title: Bi;
  description: Bi;
  instructions: Bi;
  equipment: Bi[];
  safetyNotes: Bi | null;
  recording: ChallengeRecording;
  minDurationS: number;
  maxDurationS: number;
  attemptLimit: number;
  requiresPartner: boolean;
  ageGroups: AgeBand[];
  rules: ChallengeRuleText[];
  rubric: Rubric;
}

const ALL_AGES: AgeBand[] = ['u13', 'u16', 'u18', 'adult'];
const BALL: Bi = { en: 'A football (size 4 or 5)', ar: 'كرة قدم (مقاس 4 أو 5)' };
const CONES = (n: number): Bi => ({ en: `${n} cones or markers (shoes or bottles work)`, ar: `${n} أقماع أو علامات (تصلح الأحذية أو الزجاجات)` });
const PHONE: Bi = { en: 'A phone on a stand or held by a friend', ar: 'هاتف على حامل أو يمسكه صديق' };

/** Rules every template carries. */
const COMMON_RULES: ChallengeRuleText[] = [
  { kind: 'eligibility', body: { en: 'Open to registered players in the listed age groups. Players under 18 need their guardian’s approval on KICKSCOUT.', ar: 'مفتوح للاعبين المسجلين ضمن الفئات العمرية المذكورة. يحتاج من هم دون 18 عاماً إلى موافقة ولي الأمر على KICKSCOUT.' } },
  { kind: 'recording', body: { en: 'One continuous take, no cuts, no speed changes, no filters that hide the ball or feet.', ar: 'لقطة واحدة متواصلة، بلا قص ولا تغيير للسرعة ولا فلاتر تخفي الكرة أو القدمين.' } },
  { kind: 'disqualification', body: { en: 'Edited or sped-up clips, someone else’s clip, or anything that breaks the KICKSCOUT content rules is disqualified.', ar: 'تُستبعد المقاطع المعدلة أو المسرّعة، أو مقطع شخص آخر، أو أي محتوى يخالف قواعد المحتوى في KICKSCOUT.' } },
  { kind: 'safety', body: { en: 'Film on a safe, open surface you are allowed to use. Never on a road, near traffic, at a height or on someone else’s property.', ar: 'صوّر على أرض آمنة ومفتوحة مسموح لك باستخدامها. لا تصوّر أبداً في طريق أو قرب السيارات أو في مكان مرتفع أو في ملكية غيرك.' } },
];

const judged = (criteria: { key: string; en: string; ar: string; weight: number }[], summary: Bi, opts: Partial<Rubric> = {}): Rubric => ({
  method: 'judged', unit: 'points', direction: 'higher',
  components: criteria.map((c) => ({ key: c.key, kind: 'criterion', weight: c.weight, max: 10, label: { en: c.en, ar: c.ar } })),
  tieBreakers: ['earliest_submission'], minJudges: 1, tolerance: 15, summary, aiCapability: null, ...opts,
});

export const CHALLENGE_TEMPLATES: readonly ChallengeTemplate[] = [
  {
    slug: 'tpl-juggling-king', templateKey: 'juggling_king', format: 'weekly', category: 'ball_control', difficulty: 'beginner', skillKey: 'juggling', hashtag: 'jugglingking',
    title: { en: 'Juggling King', ar: 'ملك تنطيط الكرة' },
    description: { en: 'How many touches can you keep the ball up for? Count your consecutive, controlled touches in one take, with any legal body part, and see where you stand this week.', ar: 'كم لمسة تستطيع أن تُبقي الكرة في الهواء؟ عُدّ لمساتك المتتالية والمسيطر عليها في لقطة واحدة بأي جزء مسموح من الجسم، واعرف ترتيبك هذا الأسبوع.' },
    instructions: { en: 'Start with the ball in your hands or on the ground. Keep it up with feet, thighs, chest or head. Hands and arms do not count. Your score is the longest run of touches before the ball touches the ground. Say your count out loud if you can: it helps the judge.', ar: 'ابدأ والكرة في يديك أو على الأرض. أبقِها في الهواء بالقدمين أو الفخذين أو الصدر أو الرأس. اليدان والذراعان لا تُحتسب. نتيجتك أطول سلسلة لمسات قبل أن تلمس الكرة الأرض. قل العدد بصوت عالٍ إن استطعت: هذا يساعد الحكم.' },
    equipment: [BALL, PHONE], safetyNotes: null,
    recording: { camera: 'side', orientation: 'vertical', continuousTake: true, notes: { en: 'Keep your whole body and the ball in frame from first touch to last.', ar: 'أبقِ جسمك كله والكرة داخل الإطار من أول لمسة إلى آخرها.' } },
    minDurationS: 5, maxDurationS: 60, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES, { kind: 'general', body: { en: 'A touch with the hand or arm ends the run.', ar: 'لمس الكرة باليد أو الذراع ينهي السلسلة.' } }],
    rubric: {
      method: 'measured', unit: 'count', direction: 'higher',
      components: [{ key: 'touches', kind: 'measure', max: 600, label: { en: 'Consecutive touches', ar: 'لمسات متتالية' } }],
      tieBreakers: ['earliest_submission'], minJudges: 1, tolerance: 2, aiCapability: 'juggle_count',
      summary: { en: 'A judge counts your longest run of consecutive touches. If the count differs from yours by more than 2, a second judge counts it too.', ar: 'يعدّ الحكم أطول سلسلة لمسات متتالية لديك. إذا اختلف العدد عن عددك بأكثر من 2، يعدّها حكم ثانٍ أيضاً.' },
    },
  },
  {
    slug: 'tpl-weak-foot', templateKey: 'weak_foot', format: 'weekly', category: 'weak_foot', difficulty: 'intermediate', skillKey: 'ball_control', hashtag: 'weakfootchallenge',
    title: { en: 'Weak Foot Challenge', ar: 'تحدي القدم الضعيفة' },
    description: { en: 'Great players use both feet. Show the week’s skill with your weaker foot only: inside-outside touches, a drag-back and a pass against a wall. Judges look at technique, control and consistency.', ar: 'اللاعبون الكبار يستخدمون القدمين. أدِّ مهارة الأسبوع بقدمك الأضعف فقط: لمسات بباطن القدم وظاهرها، وسحب للخلف، وتمريرة على الحائط. يقيّم الحكام الأسلوب والتحكم والثبات.' },
    instructions: { en: 'Tell us which foot is your weaker one at the start of the clip. Do 10 inside-outside touches, one drag-back, then pass the ball against a wall and control it, all with your weaker foot. Using your stronger foot to play the ball disqualifies the attempt.', ar: 'قل في بداية المقطع أي قدم هي الأضعف لديك. نفّذ 10 لمسات بباطن القدم وظاهرها، ثم سحبة للخلف، ثم مرر الكرة على حائط واستلمها، كل ذلك بقدمك الأضعف. استخدام القدم الأقوى في لعب الكرة يلغي المحاولة.' },
    equipment: [BALL, { en: 'A wall or rebounder', ar: 'حائط أو لوح ارتداد' }, PHONE], safetyNotes: null,
    recording: { camera: 'front', orientation: 'vertical', continuousTake: true },
    minDurationS: 10, maxDurationS: 60, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES, { kind: 'disqualification', body: { en: 'Playing the ball with the stronger foot.', ar: 'لعب الكرة بالقدم الأقوى.' } }],
    rubric: judged([
      { key: 'technique', en: 'Technique', ar: 'الأسلوب', weight: 0.5 },
      { key: 'control', en: 'Control', ar: 'التحكم', weight: 0.3 },
      { key: 'consistency', en: 'Consistency', ar: 'الثبات', weight: 0.2 },
    ], { en: 'Judges mark technique (50%), control (30%) and consistency (20%) from 0 to 10. The result is out of 100.', ar: 'يمنح الحكام درجات للأسلوب (50%) والتحكم (30%) والثبات (20%) من 0 إلى 10. النتيجة من 100.' }),
  },
  {
    slug: 'tpl-three-move-combo', templateKey: 'three_move_combo', format: 'standard', category: 'combo', difficulty: 'intermediate', skillKey: 'dribbling', hashtag: 'threemovecombo',
    title: { en: 'Three-Move Combo', ar: 'تحدي الحركات الثلاث' },
    description: { en: 'Link three different moves into one continuous run: for example a step-over, a drag-back and a Cruyff turn. Judges count the valid moves and score how smoothly you chain them.', ar: 'اربط ثلاث حركات مختلفة في انطلاقة واحدة متواصلة: مثل المقص والسحب للخلف ودوران كرويف. يعدّ الحكام الحركات الصحيحة ويقيّمون سلاسة الربط بينها.' },
    instructions: { en: 'Pick any three distinct moves. Perform them one after another without stopping the ball, then finish with a touch into space. Name your three moves in the description so judges know what to look for.', ar: 'اختر أي ثلاث حركات مختلفة. نفّذها واحدة تلو الأخرى دون إيقاف الكرة، ثم أنهِ بلمسة نحو المساحة. اكتب أسماء الحركات الثلاث في الوصف ليعرف الحكام ما ينتظرونه.' },
    equipment: [BALL, CONES(2), PHONE], safetyNotes: null,
    recording: { camera: 'side', orientation: 'any', continuousTake: true },
    minDurationS: 4, maxDurationS: 30, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES],
    rubric: {
      method: 'judged', unit: 'points', direction: 'higher',
      components: [
        { key: 'valid_moves', kind: 'criterion', weight: 0.4, max: 3, label: { en: 'Valid distinct moves (0-3)', ar: 'حركات مختلفة صحيحة (0-3)' } },
        { key: 'flow', kind: 'criterion', weight: 0.3, max: 10, label: { en: 'Flow between moves', ar: 'السلاسة بين الحركات' } },
        { key: 'execution', kind: 'criterion', weight: 0.3, max: 10, label: { en: 'Execution', ar: 'التنفيذ' } },
      ],
      tieBreakers: ['higher_component:valid_moves', 'earliest_submission'], minJudges: 1, tolerance: 15, aiCapability: 'move_recognition',
      summary: { en: 'Judges count valid distinct moves (40%) and mark the flow (30%) and execution (30%). The result is out of 100.', ar: 'يعدّ الحكام الحركات المختلفة الصحيحة (40%) ويقيّمون السلاسة (30%) والتنفيذ (30%). النتيجة من 100.' },
    },
  },
  {
    slug: 'tpl-rainbow-flick', templateKey: 'rainbow_flick', format: 'standard', category: 'freestyle', difficulty: 'advanced', skillKey: 'rainbow_flick', hashtag: 'rainbowflick',
    title: { en: 'Rainbow Flick', ar: 'تحدي قوس قزح' },
    description: { en: 'Roll the ball up the back of your leg and flick it over your head, then bring it under control. This week’s variation: from a standing start, finishing with a controlled first touch.', ar: 'دحرج الكرة على ظهر ساقك واقذفها فوق رأسك، ثم سيطر عليها. نسخة هذا الأسبوع: من وضع الوقوف، مع إنهاء بلمسة أولى مسيطر عليها.' },
    instructions: { en: 'Trap the ball between your feet, roll it up the back of your standing leg with the other foot and flick it over your head. Let it land in front of you and control it with your first touch.', ar: 'ثبّت الكرة بين قدميك، ودحرجها على ظهر ساق الارتكاز بالقدم الأخرى واقذفها فوق رأسك. دعها تهبط أمامك وسيطر عليها من اللمسة الأولى.' },
    equipment: [BALL, PHONE],
    safetyNotes: { en: 'Warm up first and try it on grass. Do not attempt it at speed or near other people.', ar: 'قم بالإحماء أولاً وجرّبها على العشب. لا تحاولها بسرعة عالية أو قرب أشخاص آخرين.' },
    recording: { camera: 'side', orientation: 'vertical', continuousTake: true },
    minDurationS: 3, maxDurationS: 20, attemptLimit: 5, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES],
    rubric: judged([
      { key: 'execution', en: 'Execution', ar: 'التنفيذ', weight: 0.5 },
      { key: 'control', en: 'Control on landing', ar: 'التحكم عند الهبوط', weight: 0.3 },
      { key: 'continuation', en: 'Continuation', ar: 'الاستمرار باللعب', weight: 0.2 },
    ], { en: 'Judges mark execution (50%), control on landing (30%) and how you carry on (20%). The result is out of 100.', ar: 'يقيّم الحكام التنفيذ (50%) والتحكم عند الهبوط (30%) والاستمرار باللعب (20%). النتيجة من 100.' }),
  },
  {
    slug: 'tpl-cone-master', templateKey: 'cone_master', format: 'weekly', category: 'dribbling', difficulty: 'beginner', skillKey: 'dribbling', hashtag: 'conemaster',
    title: { en: 'Cone Master', ar: 'سيد الأقماع' },
    description: { en: 'Dribble through a slalom of six cones and back as fast as you can. Your time counts, and every missed or knocked cone adds two seconds. Fast feet, close control.', ar: 'راوغ بين ستة أقماع ذهاباً وإياباً بأسرع ما يمكن. يُحتسب وقتك، وكل قمع تفوّته أو تُسقطه يضيف ثانيتين. أقدام سريعة وتحكم قريب.' },
    instructions: { en: 'Place 6 cones in a straight line, one metre apart, with a start line one metre before the first. Start with the ball on the line, weave through every cone to the end, turn, and weave back across the start line. The clock runs from your first touch to the ball crossing the line.', ar: 'ضع 6 أقماع في خط مستقيم بين كل واحد والآخر متر، وخط بداية قبل القمع الأول بمتر. ابدأ والكرة على الخط، وراوغ بين كل الأقماع حتى النهاية، ثم استدر وراوغ عائداً حتى تعبر خط البداية. يبدأ الوقت من لمستك الأولى حتى تعبر الكرة الخط.' },
    equipment: [BALL, CONES(7), PHONE], safetyNotes: null,
    recording: { camera: 'side', orientation: 'horizontal', continuousTake: true, notes: { en: 'All six cones and the start line must be visible the whole time.', ar: 'يجب أن تظهر الأقماع الستة وخط البداية طوال الوقت.' } },
    minDurationS: 5, maxDurationS: 60, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES, { kind: 'disqualification', body: { en: 'Cones more or less than one metre apart, or a course out of shot.', ar: 'أقماع تبعد أكثر أو أقل من متر، أو مسار خارج الكادر.' } }],
    rubric: {
      method: 'measured', unit: 'ms', direction: 'lower',
      components: [
        { key: 'time_ms', kind: 'measure', max: 120000, label: { en: 'Time (milliseconds)', ar: 'الوقت (بالمللي ثانية)' } },
        { key: 'missed_cones', kind: 'penalty', max: 12, perUnit: 2000, label: { en: 'Missed or knocked cones', ar: 'أقماع فائتة أو ساقطة' } },
      ],
      tieBreakers: ['fewer_penalties', 'earliest_submission'], minJudges: 1, tolerance: 300, aiCapability: 'course_time',
      summary: { en: 'A judge times your run from the clip. Each missed or knocked cone adds 2 seconds. Lowest time wins; fewer penalties breaks a tie.', ar: 'يحسب الحكم زمنك من المقطع. كل قمع فائت أو ساقط يضيف ثانيتين. الأقل زمناً يفوز؛ والأقل عقوبات يحسم التعادل.' },
    },
  },
  {
    slug: 'tpl-panna', templateKey: 'panna', format: 'standard', category: 'dribbling', difficulty: 'intermediate', skillKey: 'nutmeg', hashtag: 'pannachallenge',
    title: { en: 'Panna Challenge', ar: 'تحدي البانا' },
    description: { en: 'Put the ball through your opponent’s legs and collect it on the other side. Play it against a friend who agreed to be filmed, or use the solo version through a pair of cones set as a gate.', ar: 'مرّر الكرة بين ساقي منافسك واستلمها من الجهة الأخرى. العبها أمام صديق وافق على التصوير، أو استخدم النسخة الفردية عبر بوابة من قمعين.' },
    instructions: { en: 'With a partner: face them a few metres apart, approach, and play the ball through their legs, then go around and collect it. Solo version: set two cones 40 cm apart as legs, dribble at them, slip the ball through and collect it. Show one clean panna.', ar: 'مع شريك: قف أمامه على بعد أمتار، تقدّم ومرّر الكرة بين ساقيه، ثم التف واستلمها. النسخة الفردية: ضع قمعين بينهما 40 سم كأنهما ساقان، راوغ نحوهما ومرّر الكرة بينهما واستلمها. أظهر بانا نظيفة واحدة.' },
    equipment: [BALL, CONES(2), PHONE],
    safetyNotes: { en: 'If a partner is in the clip they must agree to be filmed and to appear on KICKSCOUT. No contact, no tackles, keep it friendly.', ar: 'إذا ظهر شريك في المقطع فيجب أن يوافق على التصوير والظهور على KICKSCOUT. لا التحام ولا تدخلات، حافظ على الروح الودية.' },
    recording: { camera: 'side', orientation: 'any', continuousTake: true },
    minDurationS: 3, maxDurationS: 30, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES, { kind: 'eligibility', body: { en: 'Anyone else in the clip must agree to appear. Players under 18 should only film with people their guardian knows.', ar: 'يجب أن يوافق كل من يظهر في المقطع على الظهور. يُفضّل أن يصوّر من هم دون 18 عاماً فقط مع أشخاص يعرفهم ولي أمرهم.' } }],
    rubric: judged([
      { key: 'execution', en: 'Execution', ar: 'التنفيذ', weight: 0.5 },
      { key: 'control', en: 'Collecting the ball', ar: 'استلام الكرة', weight: 0.3 },
      { key: 'creativity', en: 'Creativity', ar: 'الإبداع', weight: 0.2 },
    ], { en: 'Judges mark execution (50%), how cleanly you collect the ball (30%) and creativity (20%). Solo and partner versions are judged the same way.', ar: 'يقيّم الحكام التنفيذ (50%) ونظافة استلام الكرة (30%) والإبداع (20%). النسختان الفردية ومع شريك تُقيَّمان بالطريقة نفسها.' }),
  },
  {
    slug: 'tpl-first-touch', templateKey: 'first_touch', format: 'weekly', category: 'first_touch', difficulty: 'beginner', skillKey: 'first_touch', hashtag: 'firsttouchchallenge',
    title: { en: 'First Touch Challenge', ar: 'تحدي اللمسة الأولى' },
    description: { en: 'Ten balls are played to you, from a wall or a friend. How many can you kill dead inside a two-metre box with your first touch? Clean control under a fixed number of attempts.', ar: 'تُلعب لك عشر كرات من حائط أو صديق. كم واحدة تستطيع إيقافها داخل مربع بطول مترين من اللمسة الأولى؟ تحكم نظيف ضمن عدد ثابت من المحاولات.' },
    instructions: { en: 'Mark a 2 m by 2 m box with four markers. Stand inside it. Ten balls are delivered to you (passed by a friend or rebounded off a wall from at least 5 m). A controlled touch keeps the ball inside the box. Count the controlled touches out of 10.', ar: 'حدّد مربعاً بطول مترين وعرض مترين بأربع علامات وقف داخله. تصلك عشر كرات (يمررها صديق أو ترتد من حائط على بعد 5 أمتار على الأقل). اللمسة المسيطر عليها تُبقي الكرة داخل المربع. عُدّ اللمسات الناجحة من 10.' },
    equipment: [BALL, CONES(4), PHONE], safetyNotes: null,
    recording: { camera: 'front', orientation: 'horizontal', continuousTake: true, notes: { en: 'The box and where each ball comes from must be in shot.', ar: 'يجب أن يظهر المربع ومصدر كل كرة في الكادر.' } },
    minDurationS: 10, maxDurationS: 60, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES],
    rubric: {
      method: 'measured', unit: 'hits', direction: 'higher', attempts: 10,
      components: [{ key: 'controlled', kind: 'measure', max: 10, label: { en: 'Controlled first touches (of 10)', ar: 'لمسات أولى ناجحة (من 10)' } }],
      tieBreakers: ['earliest_submission'], minJudges: 1, tolerance: 0, aiCapability: null,
      summary: { en: 'A judge counts first touches that keep the ball inside the box, out of 10 deliveries.', ar: 'يعدّ الحكم اللمسات الأولى التي تُبقي الكرة داخل المربع من أصل 10 كرات.' },
    },
  },
  {
    slug: 'tpl-around-the-world', templateKey: 'around_the_world', format: 'standard', category: 'freestyle', difficulty: 'advanced', skillKey: 'freestyle', hashtag: 'aroundtheworld',
    title: { en: 'Around the World', ar: 'حول العالم' },
    description: { en: 'The classic freestyle move: kick the ball up and circle your foot around it before it drops, then keep juggling. How many clean Around the Worlds can you land in one take?', ar: 'الحركة الكلاسيكية في الفريستايل: ارفع الكرة ودوّر قدمك حولها قبل أن تسقط، ثم واصل التنطيط. كم مرة نظيفة تستطيع تنفيذها في لقطة واحدة؟' },
    instructions: { en: 'While juggling, flick the ball up with your foot and move the same foot in a full circle around it, then touch it again before it lands. Only a full circle followed by a controlled touch counts. Keep going: your score is the number of clean Around the Worlds in the clip.', ar: 'أثناء التنطيط، ارفع الكرة بقدمك وحرّك القدم نفسها في دائرة كاملة حولها، ثم المسها مرة أخرى قبل أن تهبط. تُحتسب فقط الدائرة الكاملة التي تتبعها لمسة مسيطر عليها. استمر: نتيجتك عدد الحركات النظيفة في المقطع.' },
    equipment: [BALL, PHONE],
    safetyNotes: { en: 'Warm up your hips and ankles first. Stop if you feel any strain.', ar: 'قم بإحماء الوركين والكاحلين أولاً. توقف إذا شعرت بأي شد.' },
    recording: { camera: 'front', orientation: 'vertical', continuousTake: true },
    minDurationS: 3, maxDurationS: 60, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES],
    rubric: {
      method: 'measured', unit: 'count', direction: 'higher',
      components: [{ key: 'clean_atw', kind: 'measure', max: 200, label: { en: 'Clean Around the Worlds', ar: 'حركات نظيفة' } }],
      tieBreakers: ['earliest_submission'], minJudges: 1, tolerance: 1, aiCapability: null,
      summary: { en: 'A judge counts full circles followed by a controlled touch.', ar: 'يعدّ الحكم الدوائر الكاملة التي تتبعها لمسة مسيطر عليها.' },
    },
  },
  {
    slug: 'tpl-target-shot', templateKey: 'target_shot', format: 'weekly', category: 'shooting', difficulty: 'beginner', skillKey: 'shooting', hashtag: 'targetshot',
    title: { en: 'Target Shot', ar: 'التسديد على الهدف' },
    description: { en: 'Ten shots, one target. Hang or mark a target in a goal corner or on a wall, step back eleven metres and see how many of your ten shots hit it. Accuracy beats power.', ar: 'عشر تسديدات وهدف واحد. علّق أو ارسم هدفاً في زاوية المرمى أو على حائط، وابتعد أحد عشر متراً، وانظر كم تسديدة من العشر تصيبه. الدقة أهم من القوة.' },
    instructions: { en: 'Mark a target about 1 m by 1 m (a towel, a cone on a bar, or tape on a wall you may use). Place the ball 11 m away. Take ten shots in one continuous clip. A hit is a shot that touches the target. Count your hits out of 10.', ar: 'حدّد هدفاً بحجم متر في متر تقريباً (منشفة، أو قمع على العارضة، أو شريط على حائط مسموح لك باستخدامه). ضع الكرة على بعد 11 متراً. سدد عشر تسديدات في مقطع واحد متواصل. الإصابة هي التسديدة التي تلمس الهدف. عُدّ إصاباتك من 10.' },
    equipment: [BALL, { en: 'A target about 1 m by 1 m', ar: 'هدف بحجم متر في متر تقريباً' }, PHONE],
    safetyNotes: { en: 'Make sure nobody is near the target or behind it, and never shoot at windows or cars.', ar: 'تأكد أن لا أحد قرب الهدف أو خلفه، ولا تسدد أبداً نحو النوافذ أو السيارات.' },
    recording: { camera: 'behind', orientation: 'horizontal', continuousTake: true, notes: { en: 'Film from behind the shooter so the target and every shot are visible.', ar: 'صوّر من خلف المسدد بحيث يظهر الهدف وكل تسديدة.' } },
    minDurationS: 15, maxDurationS: 60, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES, { kind: 'disqualification', body: { en: 'More than ten shots in the clip, or a shooting distance under 11 m.', ar: 'أكثر من عشر تسديدات في المقطع، أو مسافة تسديد أقل من 11 متراً.' } }],
    rubric: {
      method: 'measured', unit: 'hits', direction: 'higher', attempts: 10,
      components: [{ key: 'hits', kind: 'measure', max: 10, label: { en: 'Target hits (of 10)', ar: 'إصابات الهدف (من 10)' } }],
      tieBreakers: ['earliest_submission'], minJudges: 1, tolerance: 0, aiCapability: 'target_hits',
      summary: { en: 'A judge counts shots that touch the target, out of exactly ten.', ar: 'يعدّ الحكم التسديدات التي تلمس الهدف من أصل عشر بالضبط.' },
    },
  },
  {
    slug: 'tpl-walking-juggle', templateKey: 'walking_juggle', format: 'standard', category: 'ball_control', difficulty: 'intermediate', skillKey: 'juggling', hashtag: 'walkingjuggle',
    title: { en: 'Walking Juggle', ar: 'التنطيط أثناء المشي' },
    description: { en: 'Juggle while you walk a ten-metre course between two markers. Your time counts, and every drop adds five seconds. Control on the move is what matches look like.', ar: 'نطّط الكرة وأنت تمشي مسافة عشرة أمتار بين علامتين. يُحتسب وقتك، وكل سقوط للكرة يضيف خمس ثوانٍ. التحكم أثناء الحركة يشبه ما يحدث في المباريات.' },
    instructions: { en: 'Set two markers 10 m apart. Start juggling at the first marker and walk to the second while keeping the ball up. If the ball drops, pick it up and carry on from where it fell. The clock stops when you pass the second marker.', ar: 'ضع علامتين بينهما 10 أمتار. ابدأ التنطيط عند العلامة الأولى وامشِ إلى الثانية والكرة في الهواء. إذا سقطت الكرة، التقطها وتابع من مكان سقوطها. يتوقف الوقت عندما تتجاوز العلامة الثانية.' },
    equipment: [BALL, CONES(2), PHONE], safetyNotes: null,
    recording: { camera: 'side', orientation: 'horizontal', continuousTake: true },
    minDurationS: 5, maxDurationS: 60, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES],
    rubric: {
      method: 'measured', unit: 'ms', direction: 'lower',
      components: [
        { key: 'time_ms', kind: 'measure', max: 120000, label: { en: 'Time (milliseconds)', ar: 'الوقت (بالمللي ثانية)' } },
        { key: 'drops', kind: 'penalty', max: 20, perUnit: 5000, label: { en: 'Drops', ar: 'مرات السقوط' } },
      ],
      tieBreakers: ['fewer_penalties', 'earliest_submission'], minJudges: 1, tolerance: 300, aiCapability: null,
      summary: { en: 'A judge times the course; each drop adds 5 seconds. Lowest time wins.', ar: 'يحسب الحكم زمن المسار؛ وكل سقوط يضيف 5 ثوانٍ. الأقل زمناً يفوز.' },
    },
  },
  {
    slug: 'tpl-trick-of-the-week', templateKey: 'trick_of_the_week', format: 'weekly', category: 'freestyle', difficulty: 'expert', skillKey: 'freestyle', hashtag: 'trickoftheweek',
    title: { en: 'Trick of the Week: Double Kick', ar: 'حركة الأسبوع: الركلة المزدوجة' },
    description: { en: 'For experienced freestylers. Two touches with the same foot in one jump, then land and keep juggling. Judged on execution, difficulty and a clean landing. Only try it if you can already juggle comfortably.', ar: 'للاعبي الفريستايل ذوي الخبرة. لمستان بالقدم نفسها في قفزة واحدة، ثم الهبوط ومواصلة التنطيط. يُقيَّم التنفيذ والصعوبة والهبوط النظيف. لا تجربها إلا إذا كنت تنطّط الكرة بارتياح.' },
    instructions: { en: 'From juggling, pop the ball to knee height, jump, and touch it twice with the same foot before landing. Land balanced and keep the ball up for at least three more touches.', ar: 'أثناء التنطيط، ارفع الكرة إلى مستوى الركبة، واقفز، والمسها مرتين بالقدم نفسها قبل الهبوط. اهبط متوازناً وأبقِ الكرة في الهواء ثلاث لمسات أخرى على الأقل.' },
    equipment: [BALL, PHONE],
    safetyNotes: { en: 'Advanced trick: warm up properly, use a flat grass or turf surface, and stop if you feel pain. Never try it on concrete, stairs or anything raised.', ar: 'حركة متقدمة: قم بإحماء جيد، واستخدم أرضاً عشبية مستوية، وتوقف إذا شعرت بألم. لا تجربها أبداً على الخرسانة أو الدرج أو أي سطح مرتفع.' },
    recording: { camera: 'side', orientation: 'vertical', continuousTake: true },
    minDurationS: 3, maxDurationS: 30, attemptLimit: 5, requiresPartner: false, ageGroups: ['u16', 'u18', 'adult'],
    rules: [...COMMON_RULES],
    rubric: judged([
      { key: 'execution', en: 'Execution', ar: 'التنفيذ', weight: 0.5 },
      { key: 'difficulty', en: 'Difficulty', ar: 'الصعوبة', weight: 0.3 },
      { key: 'landing', en: 'Clean landing', ar: 'الهبوط النظيف', weight: 0.2 },
    ], { en: 'Two judges mark execution (50%), difficulty (30%) and landing (20%). The result is their average, out of 100.', ar: 'يمنح حكمان درجات للتنفيذ (50%) والصعوبة (30%) والهبوط (20%). النتيجة متوسط درجاتهما من 100.' }, { minJudges: 2 }),
  },
  {
    slug: 'tpl-beat-my-skill', templateKey: 'beat_my_skill', format: 'beat_my_skill', category: 'combo', difficulty: 'intermediate', skillKey: 'dribbling', hashtag: 'beatmyskill',
    title: { en: 'Beat My Skill', ar: 'تفوّق على مهارتي' },
    description: { en: 'Pick an approved entry from another player in this challenge and answer it: reproduce the skill, or improve on it. Judges score how faithfully you match it, how well you execute it and what you add.', ar: 'اختر مشاركة معتمدة للاعب آخر في هذا التحدي وردّ عليها: أعد المهارة أو طوّرها. يقيّم الحكام مدى مطابقتك لها وجودة تنفيذك وما أضفته.' },
    instructions: { en: 'Open an approved entry, tap “Beat this skill”, and record your version. You can reproduce it exactly or add a harder finish. Credit the original by keeping the link: KICKSCOUT shows both side by side.', ar: 'افتح مشاركة معتمدة، واضغط "تفوّق على هذه المهارة"، وسجّل نسختك. يمكنك إعادتها كما هي أو إضافة نهاية أصعب. تبقى المشاركة الأصلية مرتبطة بمشاركتك ويعرض KICKSCOUT الاثنتين جنباً إلى جنب.' },
    equipment: [BALL, PHONE], safetyNotes: null,
    recording: { camera: 'any', orientation: 'vertical', continuousTake: true },
    minDurationS: 3, maxDurationS: 45, attemptLimit: 3, requiresPartner: false, ageGroups: ALL_AGES,
    rules: [...COMMON_RULES, { kind: 'general', body: { en: 'You can only answer an approved, public entry, and not your own.', ar: 'يمكنك الرد فقط على مشاركة معتمدة وعامة، وليس على مشاركتك.' } }],
    rubric: judged([
      { key: 'replication', en: 'Matches the original', ar: 'مطابقة الأصل', weight: 0.4 },
      { key: 'execution', en: 'Execution', ar: 'التنفيذ', weight: 0.4 },
      { key: 'creativity', en: 'What you added', ar: 'ما أضفته', weight: 0.2 },
    ], { en: 'Judges mark how well you match the original (40%), execution (40%) and what you added (20%). The result is out of 100.', ar: 'يقيّم الحكام مطابقتك للأصل (40%) والتنفيذ (40%) وما أضفته (20%). النتيجة من 100.' }),
  },
];

export function templateBySlug(slug: string): ChallengeTemplate | undefined {
  return CHALLENGE_TEMPLATES.find((t) => t.slug === slug);
}
