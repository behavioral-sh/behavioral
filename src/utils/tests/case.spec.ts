import { expect, test } from 'bun:test'
import { camelCase, kebabCase, pascalCase } from '../../utils.ts'

test('camelCase should convert hyphenated string to camel case', () => {
  expect(camelCase('hello-world')).toBe('helloWorld')
})

test('camelCase should convert underscore separated string to camel case', () => {
  expect(camelCase('hello_world')).toBe('helloWorld')
})

test('camelCase should convert slash separated string to camel case', () => {
  expect(camelCase('hello/world')).toBe('helloWorld')
})

test('camelCase should convert umwelts separated string to camel case', () => {
  expect(camelCase('hello world')).toBe('helloWorld')
})

test('camelCase should handle multiple consecutive delimiters', () => {
  expect(camelCase('hello---world')).toBe('helloWorld')
  expect(camelCase('hello___world')).toBe('helloWorld')
  expect(camelCase('hello///world')).toBe('helloWorld')
  expect(camelCase('hello   world')).toBe('helloWorld')
})

test('camelCase should handle strings with start case', () => {
  expect(camelCase('Hello World')).toBe('helloWorld')
})

test('kebabCase should convert camel case string to kebab case', () => {
  expect(kebabCase('helloWorld')).toBe('hello-world')
})

test('kebabCase should convert underscore separated string to kebab case', () => {
  expect(kebabCase('hello_world')).toBe('hello-world')
})

test('kebabCase should convert slash separated string to kebab case', () => {
  expect(kebabCase('hello/world')).toBe('hello-world')
})

test('kebabCase should convert umwelts separated string to kebab case', () => {
  expect(kebabCase('hello world')).toBe('hello-world')
})

test('kebabCase should handle multiple consecutive delimiters', () => {
  expect(kebabCase('hello---world')).toBe('hello-world')
  expect(kebabCase('hello___world')).toBe('hello-world')
  expect(kebabCase('hello///world')).toBe('hello-world')
  expect(kebabCase('hello   world')).toBe('hello-world')
})

test('kebabCase should handle strings with start case', () => {
  expect(kebabCase('Hello World')).toBe('hello-world')
})

test('pascalCase should convert hyphenated string to Pascal case', () => {
  expect(pascalCase('hello-world')).toBe('HelloWorld')
})

test('pascalCase should convert underscore separated string to Pascal case', () => {
  expect(pascalCase('hello_world')).toBe('HelloWorld')
})

test('pascalCase should convert slash separated string to Pascal case', () => {
  expect(pascalCase('hello/world')).toBe('HelloWorld')
})

test('pascalCase should convert umwelts separated string to Pascal case', () => {
  expect(pascalCase('hello world')).toBe('HelloWorld')
})

test('pascalCase should handle multiple consecutive delimiters', () => {
  expect(pascalCase('hello---world')).toBe('HelloWorld')
  expect(pascalCase('hello___world')).toBe('HelloWorld')
  expect(pascalCase('hello///world')).toBe('HelloWorld')
  expect(pascalCase('hello   world')).toBe('HelloWorld')
})

test('pascalCase should handle strings with start case', () => {
  expect(pascalCase('Hello World')).toBe('HelloWorld')
})
