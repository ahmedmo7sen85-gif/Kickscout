import { Suspense } from 'react';
import { GuardianAccept } from './GuardianAccept';

export default function Page() {
  return <div className="wrap wrap--narrow page"><Suspense><GuardianAccept /></Suspense></div>;
}
