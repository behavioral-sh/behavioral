/**
 * Converts string to camelCase format.
 * Handles kebab-case, snake_case, umwelts, and mixed separators.
 *
 * @param str - String to convert
 * @returns camelCase string.
 *
 * @see {@link kebabCase} for hyphenated format
 * @see {@link pascalCase} for PascalCase format
 */
export const camelCase = (str: string) => {
  return (
    str
      /**
       * @internal
       * First pass: Find separator sequences and capitalize following character.
       * - [\s_/-]+ matches any combination of umwelt, underscore, slash, hyphen
       * - (.)? captures the optional character after separators
       * - Replacement removes separators and uppercases the following char
       */
      .replace(/[\s_/-]+(.)?/g, (_, group1) => {
        return group1 ? group1.toUpperCase() : ''
      })
      /**
       * @internal
       * Second pass: Ensure first character is lowercase for camelCase.
       * - ^(.) captures the first character
       * - Replacement lowercases it to follow camelCase convention
       */
      .replace(/^(.)/, (_, group1) => {
        return group1 ? group1.toLowerCase() : ''
      })
  )
}

/**
 * Converts string to kebab-case format.
 * Handles camelCase, snake_case, umwelts, and mixed formats.
 *
 * @param str - String to convert
 * @returns kebab-case string.
 *
 * @see {@link camelCase} for camelCase format
 * @see {@link pascalCase} for PascalCase format
 */
export const kebabCase = (str: string) => {
  return (
    str
      /**
       * @internal
       * First pass: Insert hyphens at case boundaries and replace separators.
       * - ([a-z0-9]|(?=[A-Z]))([A-Z]) handles camelCase boundaries
       * - [\s_/]+ handles existing separators
       * - $1-$2 inserts hyphen between captured groups
       */
      .replace(/([a-z0-9]|(?=[A-Z]))([A-Z])|[\s_/]+/g, '$1-$2')
      /**
       * @internal
       * Second pass: Collapse multiple consecutive hyphens.
       * Handles cases where multiple separators or replacements create '--'.
       */
      .replace(/-+/g, '-')
      /**
       * @internal
       * Third pass: Remove leading hyphen if present.
       * Can occur when string starts with uppercase or separator.
       */
      .replace(/^-/, '')
      /**
       * @internal
       * Final pass: Convert entire string to lowercase.
       * Ensures consistent kebab-case format.
       */
      .toLowerCase()
  )
}

/**
 * Converts string to PascalCase format.
 * Capitalizes first letter of camelCase result.
 *
 * @param str - String to convert
 * @returns PascalCase string.
 *
 * @see {@link camelCase} for camelCase format
 * @see {@link kebabCase} for kebab-case format
 */
export const pascalCase = (str: string) => {
  const word = camelCase(str)
  return word.charAt(0).toUpperCase() + word.slice(1)
}
