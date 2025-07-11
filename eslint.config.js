import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2024
            }
        },
        rules: {
            // Code quality
            'no-unused-vars': ['error', { 
                'argsIgnorePattern': '^_',
                'varsIgnorePattern': '^_' 
            }],
            'no-console': 'off', // We need console for logging
            'no-debugger': 'error',
            'no-alert': 'error',
            
            // Best practices
            'eqeqeq': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-with': 'error',
            'no-loop-func': 'error',
            'no-script-url': 'error',
            
            // Variables
            'no-undef': 'error',
            'no-global-assign': 'error',
            'no-implicit-globals': 'error',
            
            // Stylistic choices for Pi performance
            'prefer-const': 'error',
            'no-var': 'error',
            'prefer-arrow-callback': 'error',
            'prefer-template': 'error',
            'prefer-destructuring': ['error', {
                'array': true,
                'object': true
            }, {
                'enforceForRenamedProperties': false
            }],
            
            // Error handling
            'no-throw-literal': 'error',
            'prefer-promise-reject-errors': 'error',
            
            // Performance considerations for Pi
            'no-array-constructor': 'error',
            'no-new-object': 'error',
            'no-new-wrappers': 'error',
            
            // Code style
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', { 'avoidEscape': true }],
            'indent': ['error', 4],
            'comma-dangle': ['error', 'never'],
            'object-curly-spacing': ['error', 'always'],
            'array-bracket-spacing': ['error', 'never'],
            'space-before-function-paren': ['error', {
                'anonymous': 'always',
                'named': 'never',
                'asyncArrow': 'always'
            }],
            'keyword-spacing': 'error',
            'space-infix-ops': 'error',
            'no-multiple-empty-lines': ['error', { 'max': 2 }],
            'no-trailing-spaces': 'error',
            'eol-last': 'error'
        }
    },
    {
        files: ['**/*.test.js', '**/*.spec.js'],
        languageOptions: {
            globals: {
                ...globals.jest
            }
        }
    }
];