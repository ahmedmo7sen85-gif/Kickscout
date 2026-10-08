import type { ReactNode } from 'react';

export function PageHead({ title, intro, actions, kicker }: { title: string; intro?: string; actions?: ReactNode; kicker?: ReactNode }) {
  return (
    <header className="page-head">
      {kicker ? <div className="kicker">{kicker}</div> : null}
      <div className="row row--between">
        <h1 className="page-title">{title}</h1>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
      {intro ? <p className="page-intro">{intro}</p> : null}
    </header>
  );
}

export function Section({ title, children, action, id }: { title: string; children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <section className="stack" aria-labelledby={id} >
      <div className="row row--between">
        <h2 className="section-title" id={id}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
