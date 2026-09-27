import { Head } from '@inertiajs/react'
import type { ReactElement } from 'react'
import { PageHeader } from '../../components/shell/page_header'

// Type aliases, not interfaces: Inertia requires JSON-shaped props, and an interface has no
// implicit index signature, so a nested one fails that check.
type Field = {
  value: string | null
  text: string
}

type Props = {
  appVersion: string
  configHash: string
  validation: { run: string | null; text: string }
  identity: { releaseTag: Field; gitSha: Field; imageDigest: Field }
  chain: { state: 'verified' | 'stale' | 'failed' | 'never'; text: string }
}

const TONE: Record<Props['chain']['state'], string> = {
  verified: 'text-success',
  stale: 'text-warning',
  failed: 'text-danger',
  never: 'text-content-muted',
}

/**
 * About this deployment: what this system is. Every value is one the running system was
 * given or can compute; what it was not given reads "not recorded", and the audit chain is
 * reported as last verified, with its age — this page never verifies anything itself.
 */
export default function AboutShow({
  appVersion,
  configHash,
  validation,
  identity,
  chain,
}: Props): ReactElement {
  const row = (label: string, value: string, hook: string, muted = false) => (
    <tr className="border-b border-line last:border-0" data-about={hook}>
      <th className="w-48 py-2 pr-4 text-left align-top font-normal text-content-muted">{label}</th>
      <td className={`mono break-all py-2 ${muted ? 'text-content-muted' : ''}`}>{value}</td>
    </tr>
  )
  return (
    <>
      <Head title="About this deployment" />
      <PageHeader title="About this deployment" />
      <div className="scroll flex-1 p-4">
        <p className={`m-0 mb-4 text-[13px] ${TONE[chain.state]}`} data-about-chain={chain.state}>
          {chain.text}
        </p>
        <table className="w-full text-[13px]">
          <tbody>
            {row('Release', identity.releaseTag.text, 'release', !identity.releaseTag.value)}
            {row('Git commit', identity.gitSha.text, 'git-sha', !identity.gitSha.value)}
            {row('Image', identity.imageDigest.text, 'image', !identity.imageDigest.value)}
            {row('App version', appVersion, 'app-version')}
            {row('Configuration hash', configHash, 'config-hash')}
            {row('Configuration', validation.text, 'validation', !validation.run)}
          </tbody>
        </table>
        <p className="m-0 mt-4 text-[12px] text-content-muted">
          The audit chain is verified by a scheduled job that holds the signing key; this page
          reports its last verdict and when it was taken.
        </p>
      </div>
    </>
  )
}
