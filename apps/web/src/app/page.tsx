import Link from 'next/link';
import { ButtonLink } from '@/components/ui/Button';
import { HeroMedia } from '@/components/landing/HeroMedia';
import { PromoClip } from '@/components/landing/PromoClip';
import { FEET, POSITIONS, SKILL_KEYS } from '@/lib/constants';
import { pick } from '@/lib/i18n';
import { getServerDict } from '@/lib/i18n/server';
import { CHALLENGE_EXAMPLES, REEL_CLIPS, SHOWCASE_STEMS } from '@/lib/promo';

/** Landing: eleven sections in the owner's order. All media here is AI-generated and labelled. */
export default async function LandingPage() {
  const { t, locale } = await getServerDict();
  const L = t.landing;

  return (
    <div className="landing">
      {/* 1. Hero */}
      <section className="hero" id="hero" data-section="hero" aria-labelledby="hero-title">
        <HeroMedia label={L.heroAiNote} />
        <div className="wrap">
          <span className="ai-note">{L.heroAiNote}</span>
          <h1 id="hero-title">
            <span>{L.heroLine1}</span>
            <span>{L.heroLine2}</span>
            <span className="go">{L.heroLine3}</span>
          </h1>
          <p className="hero__sub">{L.heroSub}</p>
          <div className="cta-row">
            <ButtonLink href="/upload" variant="primary" size="lg" data-testid="cta-show">{L.ctaShow}</ButtonLink>
            <ButtonLink href="/discover" variant="secondary" size="lg" data-testid="cta-discover">{L.ctaDiscover}</ButtonLink>
          </div>
        </div>
      </section>

      {/* 2. Discover football talent */}
      <section className="landing-section" id="discover" data-section="discover" aria-labelledby="discover-title">
        <div className="wrap">
          <div className="head">
            <p className="kicker">{L.discoverKicker}</p>
            <h2 id="discover-title" className="display">{L.discoverTitle}</h2>
            <p className="lede">{L.discoverLede}</p>
          </div>
          <div className="strip" role="list">
            {REEL_CLIPS.map((c, i) => (
              <div key={c.stem} className="reel" role="listitem"><PromoClip stem={c.stem} seed={i} /></div>
            ))}
          </div>
        </div>
      </section>

      {/* 3. How it works */}
      <section className="landing-section" id="how" data-section="how" aria-labelledby="how-title">
        <div className="wrap">
          <div className="head">
            <p className="kicker">{L.howKicker}</p>
            <h2 id="how-title" className="display">{L.howTitle}</h2>
          </div>
          <ol className="steps">
            <li className="step"><h3>{L.howUploadTitle}</h3><p>{L.howUploadText}</p></li>
            <li className="step"><span className="step__arrow" aria-hidden="true">→</span><h3>{L.howDiscoveredTitle}</h3><p>{L.howDiscoveredText}</p></li>
            <li className="step"><span className="step__arrow" aria-hidden="true">→</span><h3>{L.howNoticedTitle}</h3><p>{L.howNoticedText}</p></li>
          </ol>
        </div>
      </section>

      {/* 4. Player showcase */}
      <section className="landing-section" id="showcase" data-section="showcase" aria-labelledby="showcase-title">
        <div className="wrap">
          <div className="head">
            <p className="kicker">{L.showcaseKicker}</p>
            <h2 id="showcase-title" className="display">{L.showcaseTitle}</h2>
          </div>
          <div className="showcase">
            <div className="card">
              <span className="avatar avatar--initials" style={{ inlineSize: 72, blockSize: 72, fontSize: 26 }} aria-hidden="true">KS</span>
              <div>
                <p className="profile-name" style={{ fontSize: '2rem' }}>{L.showcaseName}</p>
                <p className="small muted">{L.showcaseNote}</p>
              </div>
              <dl className="facts">
                <dt>{t.profile.position}</dt><dd>{L.showcaseWinger}</dd>
                <dt>{t.profile.country}</dt><dd>{L.showcaseCountry}</dd>
                <dt>{t.profile.foot}</dt><dd>{L.showcaseLeft}</dd>
              </dl>
              <div className="stats" aria-label={L.showcaseStatsNote}>
                <div><strong>–</strong><span>{t.profile.followers}</span></div>
                <div><strong>–</strong><span>{t.profile.videos}</span></div>
                <div><strong>–</strong><span>{t.profile.likes}</span></div>
              </div>
              <p className="small muted">{L.showcaseStatsNote}</p>
            </div>
            <div className="grid4">
              {SHOWCASE_STEMS.map((s, i) => <PromoClip key={s} stem={s} seed={i + 2} />)}
            </div>
          </div>
        </div>
      </section>

      {/* 5. Talent Radar */}
      <section className="landing-section" id="radar" data-section="radar" aria-labelledby="radar-title">
        <div className="wrap">
          <div className="head">
            <p className="kicker">{L.radarKicker}</p>
            <h2 id="radar-title" className="display">{L.radarTitle}</h2>
            <p className="lede">{L.radarLede}</p>
          </div>
          <div className="radar-grid">
            {([
              [L.radarRisingTitle, L.radarRisingText], [L.radarWatchedTitle, L.radarWatchedText], [L.radarSavedTitle, L.radarSavedText],
              [L.radarNewTitle, L.radarNewText], [L.radarGemsTitle, L.radarGemsText],
            ] as const).map(([h, p]) => <div key={h} className="rcat"><h3>{h}</h3><p>{p}</p></div>)}
          </div>
          <div><ButtonLink href="/radar">{L.radarCta}</ButtonLink></div>
        </div>
      </section>

      {/* 6. For players */}
      <section className="landing-section" id="players" data-section="players" aria-labelledby="players-title">
        <div className="wrap two">
          <div className="head">
            <p className="kicker">{L.playersKicker}</p>
            <h2 id="players-title" className="display">{L.playersTitle}</h2>
          </div>
          <div className="stack">
            <ul className="ticks">
              <li>{L.playersTick1}</li><li>{L.playersTick2}</li><li>{L.playersTick3}</li><li>{L.playersTick4}</li>
            </ul>
            <div className="cta-row">
              <ButtonLink href="/upload" variant="primary">{L.ctaShow}</ButtonLink>
              <ButtonLink href="/for-players" variant="ghost">{L.playersCta} →</ButtonLink>
            </div>
          </div>
        </div>
      </section>

      {/* 7. For scouts */}
      <section className="landing-section" id="scouts" data-section="scouts" aria-labelledby="scouts-title">
        <div className="wrap two">
          <div className="head">
            <p className="kicker">{L.scoutsKicker}</p>
            <h2 id="scouts-title" className="display">{L.scoutsTitle}</h2>
            <ul className="ticks">
              <li>{L.scoutsTick1}</li><li>{L.scoutsTick2}</li><li>{L.scoutsTick3}</li><li>{L.scoutsTick4}</li>
            </ul>
          </div>
          <form className="card" action="/search" method="get" aria-label={t.search.title}>
            <input type="hidden" name="type" value="players" />
            <div className="form-grid">
              <label className="field"><span className="field__label">{t.search.position}</span>
                <select name="position" className="input" defaultValue="">
                  <option value="">{t.common.any}</option>
                  {POSITIONS.map((p) => <option key={p} value={p}>{t.positions[p]}</option>)}
                </select>
              </label>
              <label className="field"><span className="field__label">{t.search.foot}</span>
                <select name="foot" className="input" defaultValue="">
                  <option value="">{t.common.any}</option>
                  {FEET.map((f) => <option key={f} value={f}>{t.feet[f]}</option>)}
                </select>
              </label>
              <label className="field"><span className="field__label">{t.search.skill}</span>
                <select name="skill" className="input" defaultValue="">
                  <option value="">{t.common.any}</option>
                  {SKILL_KEYS.map((s) => <option key={s} value={s}>{t.skills[s]}</option>)}
                </select>
              </label>
              <label className="field"><span className="field__label">{t.search.country}</span>
                <input name="country" className="input" placeholder={t.search.countryPlaceholder} maxLength={2} pattern="[A-Za-z]{2}" autoCapitalize="characters" />
              </label>
            </div>
            <div className="cta-row">
              <button type="submit" className="btn btn--primary btn--md">{t.search.title}</button>
              <Link href="/for-scouts" className="btn btn--ghost btn--md">{L.scoutsCta} →</Link>
            </div>
          </form>
        </div>
      </section>

      {/* 8. Global football community */}
      <section className="landing-section" id="community" data-section="community" aria-labelledby="community-title">
        <div className="wrap">
          <div className="head">
            <p className="kicker">{L.communityKicker}</p>
            <h2 id="community-title" className="display">{L.communityTitle}</h2>
            <p className="lede">{L.communityLede}</p>
          </div>
          <p className="ar-line" dir="rtl" lang="ar">{L.communityArLine}</p>
          <div className="langs"><span lang="en">English</span><span lang="ar">العربية</span></div>
        </div>
      </section>

      {/* 9. Challenges */}
      <section className="landing-section" id="challenges" data-section="challenges" aria-labelledby="challenges-title">
        <div className="wrap">
          <div className="head">
            <p className="kicker">{L.challengesKicker}</p>
            <h2 id="challenges-title" className="display">{L.challengesTitle}</h2>
          </div>
          <div className="challenge-cards">
            {CHALLENGE_EXAMPLES.map((c, i) => (
              <div key={c.tag} className="challenge-card">
                <PromoClip stem={c.stem} seed={i + 1} caption={L.exampleEntry} showNumber={false} />
                <h3>{c.tag}</h3>
                <p>{pick(c.text, locale)}</p>
              </div>
            ))}
          </div>
          <div><ButtonLink href="/challenges">{L.challengesCta}</ButtonLink></div>
        </div>
      </section>

      {/* 10. Safety & trust */}
      <section className="landing-section" id="safety" data-section="safety" aria-labelledby="safety-title">
        <div className="wrap">
          <div className="head">
            <p className="kicker">{L.safetyKicker}</p>
            <h2 id="safety-title" className="display">{L.safetyTitle}</h2>
          </div>
          <div className="trust">
            {([
              [L.safety1Title, L.safety1Text], [L.safety2Title, L.safety2Text], [L.safety3Title, L.safety3Text],
              [L.safety4Title, L.safety4Text], [L.safety5Title, L.safety5Text], [L.safety6Title, L.safety6Text],
            ] as const).map(([h, p]) => <div key={h}><h3>{h}</h3><p>{p}</p></div>)}
          </div>
          <div><Link href="/safety" className="link">{L.safetyCta}</Link></div>
        </div>
      </section>

      {/* 11. Final CTA */}
      <section className="landing-section final" id="final" data-section="final" aria-labelledby="final-title">
        <div className="wrap">
          <h2 id="final-title" className="display">{L.finalTitleA} <em>{L.finalTitleB}</em></h2>
          <div className="cta-row"><ButtonLink href="/upload" variant="primary" size="lg">{L.ctaShow}</ButtonLink></div>
          <p className="lede">{L.finalNote}</p>
        </div>
      </section>
    </div>
  );
}
