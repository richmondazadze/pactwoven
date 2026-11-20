import type { ReactNode } from 'react';
import { MarketingShell } from '@/components/marketing/shell';
import './marketing.css';
import './motion.css';
export default function MarketingLayout({ children }: { children: ReactNode }) { return <MarketingShell>{children}</MarketingShell>; }
