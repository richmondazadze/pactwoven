'use client';
import Link from 'next/link';
import { Icon } from '@/components/icon';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <main className="setup-page"><section className="setup-card"><Icon name="triangle-alert" size={32}/><h1>This page could not be opened.</h1><p>Your records have not been changed by this page error. Try loading the page again.</p><div className="actions"><button className="button" onClick={reset}>Try again</button><Link className="button secondary" href="/">Back to Pactwoven</Link></div></section></main>; }
