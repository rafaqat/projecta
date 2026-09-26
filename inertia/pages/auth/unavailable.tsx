import { Link } from '@adonisjs/inertia/react'
import { Head } from '@inertiajs/react'

/** Shown with status 503 when the identity provider cannot be reached; nothing internal is rendered. */
export default function Unavailable({ reference }: { reference: string }) {
  return (
    <>
      <Head title="Sign-in unavailable" />
      <div className="form-container">
        <h1>Sign-in is temporarily unavailable</h1>
        <p>
          The identity provider could not be reached, so you cannot sign in right now. This is
          usually brief.
        </p>
        <p>
          <Link href="/auth/login" className="button">
            Try again
          </Link>
        </p>
        {reference ? (
          <p className="muted">
            If it keeps happening, quote this reference: <code>{reference}</code>
          </p>
        ) : null}
      </div>
    </>
  )
}
