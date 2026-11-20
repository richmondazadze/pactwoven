import { Landing } from '@/components/landing';
import { marketingMetadata } from '@/components/marketing/metadata';
export const metadata = marketingMetadata('One operator. A coordinated team.', 'Give your AI agents a clear outcome. Bring planning, decisions and evidence together in one operations workspace.', '/');
export default function HomePage() { return <Landing/>; }
