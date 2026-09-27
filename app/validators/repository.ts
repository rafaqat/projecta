import vine from '@vinejs/vine'

export const registerRepositoryValidator = vine.compile(
  vine.object({
    url: vine.string().trim().maxLength(2048),
    name: vine.string().trim().minLength(1).maxLength(200).optional(),
    defaultRef: vine.string().trim().minLength(1).maxLength(255).optional(),
    visibility: vine.enum(['workspace', 'restricted']).optional(),
  })
)

/** The ignore list as the page sends it: one pattern per line, or null for the defaults. */
export const ignorePathsValidator = vine.compile(
  vine.object({
    ignorePaths: vine.string().maxLength(20_000).nullable(),
  })
)
