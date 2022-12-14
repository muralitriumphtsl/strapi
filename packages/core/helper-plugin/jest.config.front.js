const baseConfig = require('../../../jest.base-config.front');
const pkg = require('./package.json');

module.exports = {
  ...baseConfig,
  displayName: (pkg.strapi && pkg.strapi.name) || pkg.name,
  roots: [__dirname],
  collectCoverageFrom: ['<rootDir>/packages/core/helper-plugin/lib/src/**/*.js'],
  coverageDirectory: '<rootDir>/packages/core/helper-plugin/coverage',
};
