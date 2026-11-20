'use client';
import Link from 'next/link';
export default function Error({ reset }: { reset: () => void }) { return <section className="mk-container mk-error"><h1>This page couldn’t load.</h1><p>Try opening it again, or return to the homepage. Your workspace records are unaffected.</p><div className="mk-actions"><button type="button" className="mk-button" onClick={reset}>Try again</button><Link href="/" className="mk-text-link">Go to the homepage</Link></div></section>; }
