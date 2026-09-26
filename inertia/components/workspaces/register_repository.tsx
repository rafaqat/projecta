import { useState, type FormEvent } from 'react'
import { router } from '@inertiajs/react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

/**
 * Registers a repository through the same endpoint the API offers
 * (`POST /w/:workspace/repos`). The server's URL policy decides:
 * a rejected URL comes back as a 422 with the reason, shown under the field;
 * on 201 the page's repository list reloads and the worker fetches it; on 200 the
 * workspace already had the URL and that repository is where the reader goes.
 */
export function RegisterRepository({ workspace }: { workspace: string }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/w/${workspace}/repos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-XSRF-TOKEN': xsrf(),
        },
        body: JSON.stringify({
          url,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(branch.trim() ? { defaultRef: branch.trim() } : {}),
        }),
      })
      if (response.status === 201 || response.status === 200) {
        setUrl('')
        setName('')
        setBranch('')
        if (response.status === 200) {
          const { handle } = (await response.json()) as { handle: string }
          router.visit(`/w/${workspace}/r/${handle}`)
          return
        }
        router.reload({ only: ['repositories'] })
        return
      }
      const body = (await response.json().catch(() => ({}))) as {
        errors?: Array<{ message: string }>
      }
      setError(body.errors?.[0]?.message ?? `registration failed (${response.status})`)
    } catch {
      setError('registration failed: the server could not be reached')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} data-register-repository className="grid gap-2 px-2 pb-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_140px_auto]">
        <Input
          name="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repository"
          aria-label="Repository URL"
          required
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          aria-label="Repository name"
          autoComplete="off"
        />
        <Input
          name="branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="Branch (default)"
          aria-label="Branch"
          title="Leave empty to use the repository's default branch"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="primary" className="h-[34px] px-4" disabled={busy}>
          {busy ? 'Registering…' : 'Register'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
    </form>
  )
}

function xsrf(): string {
  const m = /XSRF-TOKEN=([^;]+)/.exec(document.cookie)
  return m ? decodeURIComponent(m[1]) : ''
}
