import { Suspense } from 'react';
import { OrgInviteAccept } from './OrgInviteAccept';

export default function Page() {
  return <div className="wrap wrap--narrow page"><Suspense><OrgInviteAccept /></Suspense></div>;
}
