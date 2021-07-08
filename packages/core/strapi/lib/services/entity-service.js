'use strict';

const _ = require('lodash');
const { has, pick } = require('lodash/fp');
const delegate = require('delegates');

const {
  convertSortQueryParams,
  convertLimitQueryParams,
  convertStartQueryParams,
} = require('@strapi/utils/lib/convert-rest-query-params');

const {
  sanitizeEntity,
  webhook: webhookUtils,
  contentTypes: contentTypesUtils,
} = require('@strapi/utils');
const uploadFiles = require('./utils/upload-files');

// TODO: those should be strapi events used by the webhooks not the other way arround
const { ENTRY_CREATE, ENTRY_UPDATE, ENTRY_DELETE } = webhookUtils.webhookEvents;

module.exports = ctx => {
  const implementation = createDefaultImplementation(ctx);

  const service = {
    implementation,
    decorate(decorator) {
      if (typeof decorator !== 'function') {
        throw new Error(`Decorator must be a function, received ${typeof decorator}`);
      }

      this.implementation = Object.assign({}, this.implementation, decorator(this.implementation));
      return this;
    },
  };

  const delegator = delegate(service, 'implementation');

  // delegate every method in implementation
  Object.keys(service.implementation).forEach(key => delegator.method(key));

  return service;
};

// TODO: move to Controller ?
const transformParamsToQuery = (uid, params = {}) => {
  const model = strapi.getModel(uid);

  const query = {
    populate: [],
  };

  // TODO: check invalid values add defaults ....

  const { start, limit, sort, filters, fields, populate, publicationState } = params;

  if (start) {
    query.offset = convertStartQueryParams(start);
  }

  if (limit) {
    query.limit = convertLimitQueryParams(limit);
  }

  if (sort) {
    query.orderBy = convertSortQueryParams(sort);
  }

  if (filters) {
    query.where = filters;
  }

  if (fields) {
    query.select = _.castArray(fields);
  }

  if (populate) {
    const { populate } = params;
    query.populate = _.castArray(populate);
  }

  // TODO: move to layer above ?
  if (publicationState && contentTypesUtils.hasDraftAndPublish(model)) {
    const { publicationState = 'live' } = params;

    const liveClause = {
      published_at: {
        $notNull: true,
      },
    };

    if (publicationState === 'live') {
      query.where = {
        $and: [liveClause, query.where || {}],
      };

      // TODO: propagate nested publicationState filter somehow
    }
  }

  return query;
};

const pickSelectionParams = pick(['fields', 'populate']);

const createDefaultImplementation = ({ db, eventHub, entityValidator }) => ({
  uploadFiles,

  async wrapOptions(options = {}) {
    return options;
  },

  emitEvent(uid, event, entity) {
    const model = strapi.getModel(uid);

    eventHub.emit(event, {
      model: model.modelName,
      entry: sanitizeEntity(entity, { model }),
    });
  },

  async find(uid, opts) {
    const { kind } = strapi.getModel(uid);

    const { params } = await this.wrapOptions(opts, { uid, action: 'find' });

    const query = transformParamsToQuery(uid, params);

    // return first element and ignore filters
    if (kind === 'singleType') {
      return db.query(uid).findOne({});
    }

    return db.query(uid).findMany(query);
  },

  async findPage(uid, opts) {
    const { params } = await this.wrapOptions(opts, { uid, action: 'findPage' });

    const query = transformParamsToQuery(uid, params);

    return db.query(uid).findPage(query);
  },

  async findWithRelationCounts(uid, opts) {
    const { params } = await this.wrapOptions(opts, { uid, action: 'findWithRelationCounts' });

    return db.query(uid).findWithRelationCounts(params);
  },

  async findOne(uid, entityId, opts) {
    const { params } = await this.wrapOptions(opts, { uid, action: 'findOne' });

    const query = transformParamsToQuery(uid, pickSelectionParams(params));

    return db.query(uid).findOne({ ...query, where: { id: entityId } });
  },

  async count(uid, opts) {
    const { params } = await this.wrapOptions(opts, { uid, action: 'count' });

    const query = transformParamsToQuery(uid, params);

    return db.query(uid).count(query);
  },

  async create(uid, opts) {
    const { params, data, files } = await this.wrapOptions(opts, { uid, action: 'create' });

    const model = strapi.getModel(uid);
    const isDraft = contentTypesUtils.isDraft(data, model);
    const validData = await entityValidator.validateEntityCreation(model, data, { isDraft });

    // select / populate
    const query = transformParamsToQuery(uid, pickSelectionParams(params));

    // TODO: wrap into transaction
    const componentData = await createComponents(uid, validData);
    const entity = await db.query(uid).create({
      ...query,
      data: Object.assign(validData, componentData),
    });

    // TODO: implement files outside of the entity service
    // if (files && Object.keys(files).length > 0) {
    //   await this.uploadFiles(entry, files, { model });
    //   entry = await this.findOne({ params: { id: entry.id } }, { model });
    // }

    this.emitEvent(uid, ENTRY_CREATE, entity);

    return entity;
  },

  async update(uid, entityId, opts) {
    const { params, data, files } = await this.wrapOptions(opts, { uid, action: 'update' });

    const model = strapi.getModel(uid);

    const existingEntry = await db.query(uid).findOne({ where: { id: entityId } });

    const isDraft = contentTypesUtils.isDraft(existingEntry, model);

    const validData = await entityValidator.validateEntityUpdate(model, data, {
      isDraft,
    });

    const query = transformParamsToQuery(uid, pickSelectionParams(params));

    // TODO: wrap in transaction
    const componentData = await updateComponents(uid, entityId, validData);

    const entity = await db.query(uid).update({
      ...query,
      where: { id: entityId },
      data: Object.assign(validData, componentData),
    });

    // TODO: implement files outside of the entity service
    // if (files && Object.keys(files).length > 0) {
    //   await this.uploadFiles(entry, files, { model });
    //   entry = await this.findOne({ params: { id: entry.id } }, { model });
    // }

    this.emitEvent(uid, ENTRY_UPDATE, entity);

    return entity;
  },

  async delete(uid, entityId, opts) {
    const { params } = await this.wrapOptions(opts, { uid, action: 'delete' });

    // select / populate
    const query = transformParamsToQuery(uid, pickSelectionParams(params));

    const entity = await db.query(uid).findOne({
      ...query,
      where: { id: entityId },
    });

    if (!entity) {
      throw new Error('Entity not found');
    }

    await deleteComponents(uid, entityId);
    await db.query(uid).delete({ where: { id: entity.id } });

    this.emitEvent(uid, ENTRY_DELETE, entity);

    return entity;
  },

  async deleteMany(uid, opts) {
    const { params } = await this.wrapOptions(opts, { uid, action: 'delete' });

    // select / populate
    const query = transformParamsToQuery(uid, pickSelectionParams(params));

    return db.query(uid).deleteMany(query);
  },

  // TODO: Implement search features
  async search(uid, opts) {
    const { params, populate } = await this.wrapOptions(opts, { uid, action: 'search' });

    return [];

    // return db.query(uid).search(params, populate);
  },

  async searchWithRelationCounts(uid, opts) {
    const { params, populate } = await this.wrapOptions(opts, {
      uid,
      action: 'searchWithRelationCounts',
    });

    return [];

    // return db.query(uid).searchWithRelationCounts(params, populate);
  },

  async searchPage(uid, opts) {
    const { params, populate } = await this.wrapOptions(opts, { uid, action: 'searchPage' });

    return [];

    // return db.query(uid).searchPage(params, populate);
  },

  async countSearch(uid, opts) {
    const { params } = await this.wrapOptions(opts, { uid, action: 'countSearch' });

    return [];

    // return db.query(uid).countSearch(params);
  },
});

// TODO: Generalize the logic to CRUD relation directly in the DB layer
const createComponents = async (uid, data) => {
  const { attributes } = strapi.getModel(uid);

  for (const attributeName in attributes) {
    const attribute = attributes[attributeName];

    if (!has(attributeName, data)) {
      continue;
    }

    if (attribute.type === 'component') {
      const { component: componentUID, repeatable = false } = attribute;

      const componentValue = data[attributeName];

      if (componentValue === null) {
        continue;
      }

      if (repeatable === true) {
        if (!Array.isArray(componentValue)) {
          throw new Error('Expected an array to create repeatable component');
        }

        const components = await Promise.all(
          componentValue.map(value => {
            return strapi.query(componentUID).create({ data: value });
          })
        );

        return {
          [attributeName]: components.map(({ id }, idx) => {
            // TODO: add & support pivot data in DB
            return id;
          }),
        };
      } else {
        const component = await strapi.query(componentUID).create({ data: componentValue });

        return {
          // TODO: add & support pivot data in DB
          [attributeName]: component.id,
        };
      }
    }

    if (attribute.type === 'dynamiczone') {
      const dynamiczoneValues = data[attributeName];

      if (!Array.isArray(dynamiczoneValues)) {
        throw new Error('Expected an array to create repeatable component');
      }

      const components = await Promise.all(
        dynamiczoneValues.map(value => {
          return strapi.query(value.__component).create({ data: value });
        })
      );

      return {
        [attributeName]: components.map(({ id }, idx) => {
          // TODO: add & support pivot data in DB
          return id;
        }),
      };
    }
  }
};

const updateOrCreateComponent = (componentUID, value) => {
  // update
  if (has('id', value)) {
    // TODO: verify the compo is associated with the entity
    return strapi.query(componentUID).update({ where: { id: value.id }, data: value });
  }

  // create
  return strapi.query(componentUID).create({ data: value });
};

// TODO: delete old components
const updateComponents = async (uid, entityId, data) => {
  const { attributes } = strapi.getModel(uid);

  for (const attributeName in attributes) {
    const attribute = attributes[attributeName];

    if (!has(attributeName, data)) {
      continue;
    }

    if (attribute.type === 'component') {
      const { component: componentUID, repeatable = false } = attribute;

      const previousValue = await strapi.query(uid).load(entityId, attributeName);
      const componentValue = data[attributeName];

      // TODO: diff prev & new

      // make diff between prev ids & data ids
      if (componentValue === null) {
        continue;
      }

      if (repeatable === true) {
        if (!Array.isArray(componentValue)) {
          throw new Error('Expected an array to create repeatable component');
        }

        const components = await Promise.all(
          componentValue.map(value => updateOrCreateComponent(componentUID, value))
        );

        return {
          [attributeName]: components.map(({ id }, idx) => {
            // TODO: add & support pivot data in DB
            return id;
          }),
        };
      } else {
        const component = await updateOrCreateComponent(componentUID, componentValue);

        return {
          // TODO: add & support pivot data in DB
          [attributeName]: component.id,
        };
      }
    }

    if (attribute.type === 'dynamiczone') {
      const dynamiczoneValues = data[attributeName];

      if (!Array.isArray(dynamiczoneValues)) {
        throw new Error('Expected an array to create repeatable component');
      }

      const components = await Promise.all(
        dynamiczoneValues.map(value => updateOrCreateComponent(value.__component, value))
      );

      return {
        [attributeName]: components.map(({ id }, idx) => {
          // TODO: add & support pivot data in DB
          return id;
        }),
      };
    }
  }
};

const deleteComponents = async (uid, entityId) => {
  const { attributes } = strapi.getModel(uid);

  // TODO:  find components and then delete them
  for (const attributeName in attributes) {
    const attribute = attributes[attributeName];

    if (attribute.type === 'component') {
      const { component: componentUID } = attribute;

      // TODO: need to load before deleting the entry then delete the components then the entry
      const value = await strapi.query(uid).load(entityId, attributeName);

      if (!value) {
        continue;
      }

      if (Array.isArray(value)) {
        await Promise.all(
          value.map(subValue => {
            return strapi.query(componentUID).delete({ where: { id: subValue.id } });
          })
        );
      } else {
        await strapi.query(componentUID).delete({ where: { id: value.id } });
      }

      continue;
    }

    if (attribute.type === 'dynamiczone') {
      continue;
    }
  }
};