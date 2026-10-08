import { ShortlistDetailView } from './ShortlistDetailView';

export default async function ShortlistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ShortlistDetailView id={id} />;
}
