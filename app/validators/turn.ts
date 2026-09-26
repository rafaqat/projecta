import vine from '@vinejs/vine'

/** Shape only; the 400-character cap is enforced by checkInput before routing. */
export const turnValidator = vine.compile(
  vine.object({
    question: vine.string().maxLength(4000),
    threadHandle: vine
      .string()
      .regex(/^[0-9a-hjkmnp-tv-z]{16}$/)
      .optional(),
    regenerate: vine
      .object({
        turnHandle: vine.string().regex(/^[0-9a-hjkmnp-tv-z]{16}$/),
        invalidEntities: vine.array(vine.string().maxLength(200)).maxLength(20),
      })
      .optional(),
  })
)
