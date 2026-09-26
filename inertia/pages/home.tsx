import { Head } from '@inertiajs/react'
import { Link } from '@adonisjs/inertia/react'
import { ShieldCheck, ScanSearch, Fingerprint } from 'lucide-react'
import { Button } from '~/components/ui/button'

// Signed-in users never reach this page: HomeController forwards them to
// their workspace or repository. This is the front door for everyone else.
export default function Home() {
  return (
    <>
      <Head title="Sign in" />
      <div className="mx-auto flex max-w-[560px] flex-1 flex-col justify-center px-6 py-16">
        <span className="mark mb-6 grid h-9 w-9 place-items-center rounded-lg text-[15px] font-semibold">
          C
        </span>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          Ask your codebase, get cited answers
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-content-secondary">
          Every answer points at the exact lines it came from, and every line is attributed to the
          person who wrote it. Sign in with your organisation account to open your workspaces.
        </p>
        <div className="mt-6">
          <Button variant="primary" asChild className="h-9 px-4 text-[14px]">
            <Link href="/auth/login">Sign in</Link>
          </Button>
        </div>
        <ul className="mt-10 grid gap-3 text-[12.5px] text-content-muted">
          {(
            [
              [ScanSearch, 'Answers cite the commit, file and lines they were built from'],
              [ShieldCheck, 'Every token and span is attributed to a person'],
              [Fingerprint, 'Each answer has a decision record in a tamper-evident chain'],
            ] as const
          ).map(([Icon, text]) => (
            <li key={text} className="flex items-center gap-2.5">
              <Icon className="h-4 w-4 flex-none" />
              {text}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
