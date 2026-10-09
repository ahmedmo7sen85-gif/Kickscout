# KICKSCOUT Guardian: football content safety

Guardian is the mandatory safety check that every uploaded video goes through before anyone else can see it. It runs on the backend. The database and the API enforce its decisions, so no account, plan or subscription can skip it, and the web app cannot publish anything on its own.

No automated system is 100% accurate. Guardian is built to fail safe:
- A clip it is unsure about goes to a person.
- A scan that cannot finish never approves anything.
- The metrics below measure how well it is doing. They don't assume it.

## Where the code lives

| Part | Location |
| --- | --- |
| Policy, categories, thresholds, enforcement ladder | `packages/domain/src/guardian.ts` |
| Scan service (`FootballVideoSafetyService`) | `apps/worker/src/guardian/service.ts` |
| Visual classifiers: screen and deep pass, provider-independent through `packages/ai` | `apps/worker/src/guardian/classifiers.ts` |
| Frame sampling, scene cuts, perceptual hashes | `apps/worker/src/guardian/sampling.ts` |
| Duplicate content detector | `apps/worker/src/guardian/duplicates.ts` |
| Text signals (English and Arabic) and the audio hook | `apps/worker/src/guardian/text.ts` |
| Risk decision engine | `apps/worker/src/guardian/engine.ts` |
| Results, review routing, strikes, audit (`ModerationAuditService`, `HumanReviewRouter`) | `apps/worker/src/guardian/records.ts` |
| Upload pipeline, publish, unpublish and rescan jobs | `apps/worker/src/pipeline.ts`, `apps/worker/src/worker.ts` |
| Evaluation metrics | `apps/worker/src/guardian/evaluation.ts` |
| API enforcement, review actions, appeals, reports, metrics | `apps/api/src/modules/guardian.ts`, `moderation.ts`, `media.ts`, `social.ts` |
| Schema | `db/migrations/0012_guardian.sql` |

## The pipeline

Each step below names the code that runs it.

1. **Validate the file.** The worker checks the type by sniffing the bytes (not the declared type), the size, the length (and the plan limit), the resolution, and decodes the whole stream. Damaged or fake files are rejected with `INTEGRITY_FAILED`, and nothing is sent to any AI.
2. **Private quarantine.** The trimmed, transcoded copy and its thumbnail go to `quarantine/<id>/…` in the private originals bucket, stored as `private, no-store`. Nothing goes to the public delivery bucket, the feeds or search.
3. **Exact duplicates.** The sha256 is checked against videos that were rejected, removed or put under legal hold. A child-safety match stops the scan right there, before any copy is sent anywhere.
4. **Frames across the whole clip.** The worker extracts an even spread of frames (one every 2 s, between 8 and 32 frames), plus one frame just after every scene cut. A short scene spliced between football shots is therefore always seen. This step never looks at only the opening seconds.
5. **Perceptual hashes.** A 64-bit dHash is computed for each frame, and also for its mirror image, and compared with the hashes of rejected videos. This catches edited re-uploads: mirrored, cropped or re-encoded.
6. **Text signals.** Local rules run on the title, description and hashtags, in English and Arabic.
7. **Screen.** A fast model looks at every sampled frame. It returns football relevance, a per-frame list of category probabilities, on-screen text, uploader text, and a confidence. If it refuses, or finds a child-safety signal, the scan stops here: no deep pass and no further copies.
8. **Deep pass.** An independent second model looks at the flagged frames, an even sample of the rest, and dense extra frames (every 300 ms within ±1.5 s) around each suspicious moment. It confirms or clears what the screen found and suggests skill tags. By default it runs on every clip, because it also produces the tags. With `deepPass: "on_risk"` it runs only when the screen saw a risk.
9. **Audio.** Pluggable, but no speech-to-text provider is wired in yet. Results say `AUDIO_NOT_CHECKED`, and reviewers can see that.
10. **Decision.** The risk decision engine (below) turns all of the above into exactly one of `APPROVED`, `REJECTED`, `HUMAN_REVIEW` or `SCAN_FAILED`.
11. **Apply it, in one transaction.** This writes the result row, the video status, the review case, any strike and enforcement, the audit entry and the owner's notice. Only then:
    - an approved clip is copied to public delivery;
    - a removed one is taken down (`video.unpublish`).
12. **Evidence.** `video_moderation_results` keeps everything needed to reconstruct the decision:
    - the scores, timestamps, frames analysed and stages;
    - the reason codes, the model versions (`screen:…;deep:…`), the policy version, latency and retries.

    `audit_logs` (and the `moderation_audit_logs` view) keeps every automatic and human action.

## Statuses and enforcement

`videos.safety_status` is one of:
- `PENDING_SCAN`
- `PROCESSING`
- `APPROVED`
- `REJECTED`
- `HUMAN_REVIEW`
- `SCAN_FAILED`
- `REMOVED`

`videos.status` keeps its existing values, and `status = 'published'` remains the single "approved and public" signal.

The database refuses `status = 'published'` unless `safety_status = 'APPROVED'` (`videos_published_requires_approval`). On top of that:
- every public list and video page in the API also requires `APPROVED`;
- a held video returns 404 to everyone except its owner, the owner's guardian and staff.

| Guardian decision | Upload | Rescan of a published video |
| --- | --- | --- |
| APPROVED | `published` (copied to delivery) | unchanged |
| REJECTED | `rejected` | `rejected` + `REMOVED`, delivery files deleted |
| HUMAN_REVIEW | `review_required` | `review_required`, taken down until decided |
| SCAN_FAILED | `review_required` if a private copy exists, else `failed` | unchanged |

Uploads are also blocked with `403 UPLOADS_RESTRICTED` while `users.upload_restricted_until` is in the future, whatever the plan.

## The risk decision engine

The rules apply in this order. The first match wins.

1. **Child safety.** This rule applies if any of these is true:
   - the clip is a known child-safety match (exact or perceptual);
   - a frame has a critical category (`child_sexual_content`, `sexual_exploitation`) at or above `childSafetySignal` (0.2);
   - the uploader is a minor (or their age is unknown), or the model says minors may be present, and a sexual category reaches its review threshold.

   The outcome is a restricted case, priority 0, and legal hold. The result is `REJECTED` if a critical category reaches its reject threshold (0.5), otherwise `HUMAN_REVIEW`.
2. **Refusal.** A model refusal leads to `HUMAN_REVIEW`. It goes to child safety if the refusal mentions minors or exploitation.
3. **Failure.** No provider, no frames, the budget exceeded, or a provider that keeps failing all lead to `SCAN_FAILED`.
4. **Confirmed violation.** The deep pass puts a category at or above its reject threshold with confidence of at least 0.6. The result is `REJECTED` with `PROHIBITED_CONTENT`, plus `DISGUISED_CONTENT` when football frames surround it.
5. **Exact re-upload** of rejected content: `REJECTED`.
6. **Still picture.** Every stage says static image: `REJECTED` with `STATIC_IMAGE`.
7. **Not football.** This rule applies when all of these hold:
   - relevance is at most 0.15;
   - no frame shows football;
   - the models are confident;
   - nothing harmful was found.

   The result is `REJECTED` with `NOT_FOOTBALL`.
8. **Anything uncertain goes to `HUMAN_REVIEW`.** That covers:
   - conflicting models, possible prohibited content;
   - football that is uncertain or only partly football;
   - text, on-screen text or audio signals;
   - a similar rejected video, a duplicate of another owner's clip;
   - low confidence.
9. **Otherwise** `APPROVED`.

Thresholds per severity (overridable per category with `GUARDIAN_POLICY`):

| Severity | Categories | Review at | Auto-reject at (deep pass, confident) |
| --- | --- | --- | --- |
| critical | child_sexual_content, sexual_exploitation | 0.05 | 0.5 |
| serious | sexual_activity, pornography, nudity, graphic_violence, hate, illegal | 0.3 | 0.85 |
| moderate | suggestive, harassment, dangerous, scam | 0.4 | never |
| minor | spam, advertising, gaming_footage, unrelated_entertainment | 0.6 | never |

To approve, football relevance must be at least 0.7, and at least half of the sampled frames must show football. Text never approves or rejects on its own.

The prompts tell both models what football context looks like: kit, sliding tackles, injuries treated on the pitch, goal celebrations. Ordinary football should therefore not be flagged as sexual or violent. Uploader text and on-screen text are wrapped as untrusted data, and `<` and `>` are neutralised, so a title cannot instruct the model.

## Child-safety process

When the child-safety workflow starts:
- No further frames go to any third-party provider. The deep pass is skipped.
- The processed copies (the quarantined playback and the thumbnail) are deleted. No extra copies or thumbnails are made.
- The original upload is kept under `legal_hold` as evidence. Maintenance never purges it.
- The case is `restricted`: only admins see it, and moderators get a 404. Its media cannot be previewed in the tool (`403 LEGAL_HOLD`).
- The account cannot upload during the investigation.
- The player sees only the neutral "waiting for a moderator" notice.

Moderators can also start this workflow by hand with `escalate_safety`. A `child_safety` report on a video starts it too: the video is taken down at once into a restricted case.

**What the team still needs to do outside the code.**
- **Hash matching.** Apply for industry child-safety hash matching (Microsoft PhotoDNA, Thorn Safer). Neither is connected yet. Once one is, plug it into `DuplicateContentDetector` ahead of any AI call.
- **Reporting duties.** Agree with counsel how confirmed material is reported to the authorities in each country you operate in (for example, NCMEC for US-hosted services, and the national hotline elsewhere). Agree who on the team is allowed to handle it.
- **Training data.** Never use real child-abuse material to test or tune Guardian. The test suite uses synthetic clips with scripted model answers.

## Anti-bypass and repeat offenders

- **Exact copies.** A sha256 match against rejected or held videos is rejected. A match from another account against a live video goes to review as a possible stolen clip.
- **Edited copies.** Mirrored, cropped or re-encoded copies are caught when their dHash frames match at least 30% of the sampled frames (and at least 3 frames, Hamming distance at most 6). They go to review at priority 1.
- **Hashes are kept for rejected and held videos.** Other videos' hashes are dropped when the video is deleted.
- **Strikes** come from automatic rejections and reviewer decisions. They expire by severity (critical 10 years, serious 180 days, moderate 90 days, minor 30 days). The ladder:
  - any critical strike suspends the account;
  - serious strikes: the first restricts uploads for 7 days, the second for 30 days, the third suspends;
  - lesser strikes add up more slowly.
- A paid plan changes none of this.
- Approving a video, including on appeal, voids its strikes.

## Human review

The admin console (`/admin`) shows each case with:
- the latest scans: decision, reason codes, probabilities, suspicious timestamps, frames and stages, model and policy versions;
- the owner's active strikes and any upload pause;
- the report history, earlier decisions and any appeal.

Actions (`POST /v1/admin/moderation-cases/:id/decision`):

| Action | Effect |
| --- | --- |
| `approve` | `APPROVED`. The worker publishes from the private copy (`video.publish`). Strikes for the video are voided. |
| `reject` / `remove` | `REJECTED` / `REMOVED`. Public files are taken down. A reviewer strike is recorded. |
| `request_review` | Case stays open. A fresh Guardian scan runs and the case is unassigned for a second reviewer. |
| `restrict_uploads` | The owner cannot upload for `days` (default 7). |
| `escalate_safety` | Child-safety workflow: restricted case, legal hold, taken down, uploads paused. |
| `assign` | Assigns the case to the acting reviewer. |
| `restrict`, `escalate`, `suspend`, `dismiss` | As before. A held upload cannot be dismissed (`409 DECISION_REQUIRED`). |

Media under review is shown only through `GET /v1/admin/moderation-cases/:id/preview`. That endpoint returns signed links that last five minutes, and every call is audited.

**Appeals.** The owner (or their guardian) appeals with `POST /v1/videos/:id/appeal`, while the private copy is kept (90 days). Only one appeal can be pending per video. The appeal opens an `appeal` case. Approving it marks the appeal overturned and voids the strike. Any other decision upholds it. The owner is notified either way.

## After publication

- **Reports.** Every report on a video triggers a fresh scan on the first report. A `child_safety` or `sexual` report, or 3 distinct reporters (`reportsToRestrict`), takes the video down (`review_required`/`HUMAN_REVIEW`) until a person decides.
- **Edits.** Changing the title, description or hashtags of a published clip triggers a rescan.
- **Rescans.**
  - Staff can rescan one video with `POST /v1/admin/videos/:id/rescan`.
  - After a policy or model change, admins rescan every published video last checked under another version with `POST /v1/admin/guardian/rescan`.
  - A rescan that rejects a public video removes it and deletes its public files.
- **Emergency removal** is `remove`, or `escalate_safety`, on the case.

## Privacy, security and retention

- Quarantined copies live in the private bucket. Owners, guardians and reviewers see them only through short-lived signed URLs, and never while under legal hold.
- Model inputs are frames (512 px on the long side) and the uploader's own text. No names, ages or account data are sent. The worker tells the model only whether stricter child-safety rules apply.
- Probabilities describe the clip, never the player. The existing "no ratings" database checks also cover the moderation verdicts.
- Retention:

  | Data | How long it is kept |
  | --- | --- |
  | Originals | deleted once settled (published originals after 7 days) |
  | Private copies of rejected and removed clips | 90 days (the appeal window), unless an appeal or case is still open |
  | Legal-hold evidence | until released by an admin; never purged by maintenance |
  | Frame hashes of rejected or held videos | kept, to stop re-uploads |

- Provider data handling: review the AI provider's data-retention terms (for the Claude API, standard API inputs are not used for training). Decide whether you need a zero-data-retention agreement before launch.

## Provider and cost

**Recommended setup.** Keep Claude through the existing `packages/ai` router:
- Haiku 5.5 for the screen (`video_screening`, effort low);
- Opus 5.5 for the deep pass and skill tags (`video_analysis`).

Every call is recorded in `ai_calls` with its token counts. The classifiers depend only on the router, so a different vision provider can be added behind `VisualClassifier` without touching the pipeline.

**Estimated cost per clip.** These are list prices in USD per million tokens, cached on 2026-10-06:

| Model | Input | Output |
| --- | --- | --- |
| Haiku 5.5 | 0.10 | 0.50 |
| Opus 5.5 | 4 | 20 |

A 512×288 frame is about 200 input tokens.

| Step | Typical tokens | Cost |
| --- | --- | --- |
| Screen, 8–32 frames + scene cuts (Haiku) | ~10k in, ~2k out | ~$0.002 |
| Deep pass on a clean clip, ~6 frames + tags (Opus) | ~3.5k in, ~2–4k out incl. reasoning | ~$0.05–0.09 |
| Deep pass on a risky clip, up to ~40 frames (Opus) | ~10k in, ~3–5k out | ~$0.10–0.14 |

Before Guardian, the same Opus call already ran on every clip to suggest skill tags. Guardian's deep pass replaces that call. The extra cost of Guardian is therefore mostly the screen: **about $0.002–0.005 per clip**, or roughly $2–5 per 1,000 uploads.

To cut the total further:
- set `AI_EFFORT_HEAVY=medium`; or
- use `deepPass: "on_risk"`, which also skips tagging on clean clips.

`dailyBudgetUsd` caps the spend per UTC day. Over the cap, new scans fail closed to review instead of costing more.

**Second opinion, later.** Add an independent, dedicated image-moderation API as a third classifier, for example AWS Rekognition content moderation or Google Cloud Vision SafeSearch. Their per-image pricing would add a few cents per clip at 32 frames, so check current prices. This mainly reduces correlated mistakes between two models from the same family.

## Measuring quality

`GET /v1/admin/guardian/metrics?days=30` (shown on `/admin`) reports:
- uploads scanned and the decision mix;
- human-review and scan-failure rates;
- average latency and average AI cost per clip;
- reviewer outcomes on held clips;
- automatic decisions later reversed: approvals later removed, rejections overturned;
- the appeal reversal rate;
- an estimated auto-reject precision, once at least 20 automatic rejections exist;
- the top reason codes and the policy versions in use.

For offline evaluation, `guardianMetrics()` and `metricsBySlice()` in `apps/worker/src/guardian/evaluation.ts` compute the following on a labelled set:
- precision and recall;
- false-positive and false-negative rates;
- football accuracy, human-review rate and scan-failure rate;
- latency and cost.

Build that set from licensed or synthetic football and non-football clips. Tag it by slice: lighting, camera angle, skin tone, kit, gender, indoor or outdoor, phone or broadcast. Then compare the slices. A slice that is rejected or sent to review much more often than the others is a fairness bug to fix before tightening thresholds. The number that must stay near zero is the **false-negative rate** (prohibited clips approved automatically).

The automated tests (`apps/worker/test/pipeline.test.ts`, `test/guardian.test.ts`, `apps/api/test/guardian.test.ts`) cover these scenarios:
- approval of football clips;
- borderline review and conflicting models;
- non-football and explicit rejection, with strikes and enforcement;
- disguised content in a 1 s spliced scene;
- minors and child safety, including no further provider calls, deleted copies and legal hold;
- exact and perceptual re-uploads, and stolen duplicates;
- text signals and prompt injection;
- missing, failing, refusing and over-budget providers;
- paid plans not bypassing the check;
- rescans and removal, publish jobs, the database check, appeals, reports, restricted cases and metrics.

## Rollout checklist

These steps need the owner's go-ahead. None of them is done by this change.

1. Apply `db/migrations/0012_guardian.sql` to production. It backfills `safety_status` from the current statuses, so published demo videos stay published as `APPROVED`. `/v1/ready` reports `pending` until it is applied.
2. Make sure the worker has `ANTHROPIC_API_KEY` set. Without it, every upload waits for a moderator.
3. Set `GUARDIAN_POLICY_VERSION` (and `GUARDIAN_POLICY` if you change thresholds or the budget) on both the worker and the API.
4. After any threshold change, run a policy rescan from the admin API.
5. Connect S3 keys so that real uploads (and so quarantine) work end to end, then test with synthetic clips.
