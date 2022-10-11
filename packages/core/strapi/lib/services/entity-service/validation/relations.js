'use strict';

const { ApplicationError } = require('@strapi/utils').errors;
const { castArray } = require('lodash/fp');
const { isEmpty, uniqBy } = require('lodash');

/**
 * Check that all the relations of an entity exist
 */
module.exports = async (data, uid, db) => {
  const relationsMap = new Map();

  const relationCheck = (data, uid) => {
    const model = strapi.getModel(uid);
    if (isEmpty(model)) return;

    Object.keys(model.attributes).forEach((attributeName) => {
      const attribute = model.attributes[attributeName];
      const value = data[attributeName];
      if (!value) {
        return;
      }
      switch (attribute.type) {
        case 'relation': {
          // If the attribute type is a relation keep track of all
          // associations being made with relations. These will later be checked
          // against the DB to confirm they exist
          let directValue = [];
          if (Array.isArray(value)) {
            directValue = value.map((v) => ({
              id: v,
            }));
          }
          relationsMap.set(attribute.target, [
            ...(relationsMap.get(attribute.target) || []),
            ...(value.connect || []),
            ...(value.set || []),
            ...directValue,
          ]);
          break;
        }
        case 'media':
          // TODO check if files exist?
          break;
        case 'component': {
          return castArray(value).forEach((componentValue) =>
            relationCheck(componentValue, attribute.component)
          );
        }
        case 'dynamiczone': {
          return value.forEach((dzValue) => {
            return relationCheck(dzValue, dzValue.__component);
          });
        }
        default:
          break;
      }
    });
  };
  relationCheck(data, uid);

  // Iterate through the relations map and validate that every relation
  // mentioned exists
  const promises = [];
  for (const [key, value] of relationsMap) {
    const evaluate = async () => {
      const uniqueValues = uniqBy(value, `id`);
      // eslint-disable-next-line no-unused-vars
      const [__, count] = await db.query(key).findWithCount({
        where: {
          id: {
            $in: uniqueValues.map((v) => v.id),
          },
        },
      });

      // TODO check for mixed string and ints
      if (count !== uniqueValues.length) {
        throw new ApplicationError(`A relation associated with this entity does not exist`);
      }
    };
    promises.push(evaluate());
  }

  await Promise.all(promises);
};
