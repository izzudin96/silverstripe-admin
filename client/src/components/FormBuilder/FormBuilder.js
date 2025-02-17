import React, { Component } from 'react';
import PropTypes from 'prop-types';
import merge from 'merge';
import schemaFieldValues, { schemaMerge } from 'lib/schemaFieldValues';
import { createErrorBlock } from 'lib/createErrorBlock';
import backend from 'lib/Backend';
import { withInjector } from 'lib/Injector';

class FormBuilder extends Component {
  constructor(props) {
    super(props);
    const schemaStructure = props.schema.schema;
    this.state = { submittingAction: null };
    this.submitApi = backend.createEndpointFetcher({
      url: schemaStructure.attributes.action,
      method: schemaStructure.attributes.method,
    });
    this.mapActionsToComponents = this.mapActionsToComponents.bind(this);
    this.mapFieldsToComponents = this.mapFieldsToComponents.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleAction = this.handleAction.bind(this);
    this.buildComponent = this.buildComponent.bind(this);
    this.validateForm = this.validateForm.bind(this);
  }

  getComponent({ name, schemaComponent, schemaType }) {
    const { identifier, getCustomFields } = this.props;

    if (getCustomFields) {
      const component = getCustomFields(schemaType, `${identifier}.${name}`);
      if (component) {
        return component;
      }
    }

    if (schemaComponent !== null) {
      return this.context.injector.get(schemaComponent, `${identifier}.${name}`);
    }

    return this.getComponentForDataType(schemaType, name);
  }

  /**
   * Default data type to component mappings.
   * Used as a fallback when no component type is provided in the form schema.
   *
   * @param {string} dataType - The data type provided by the form schema.
   * @param {string} name - name of the field component
   * @return object|null
   */
  getComponentForDataType(dataType, name) {
    const { identifier } = this.props;
    const get = (type) => this.context.injector.get(type, `${identifier}.${name}`);

    switch (dataType) {
      case 'Integer':
      case 'Decimal':
        return get('NumberField');
      case 'String':
      case 'Text':
        return get('TextField');
      case 'Date':
        return get('DateField');
      case 'Time':
        return get('TimeField');
      case 'Datetime':
        return get('DatetimeField');
      case 'Hidden':
        return get('HiddenField');
      case 'SingleSelect':
        return get('SingleSelectField');
      case 'Custom':
        return get('GridField');
      case 'Structural':
        return get('CompositeField');
      case 'Boolean':
        return get('CheckboxField');
      case 'MultiSelect':
        return get('CheckboxSetField');
      default:
        return null;
    }
  }

  /**
   * Run validation for every field on the form and return an object which list issues while
   * validating
   *
   * @param values
   * @returns {*}
   */
  validateForm(values) {
    if (typeof this.props.validate === 'function') {
      return this.props.validate(values);
    }

    const schema = this.props.schema && this.props.schema.schema;
    if (!schema) {
      return {};
    }

    const validationMiddleware = this.context.injector.validate(
      this.props.identifier
    );

    let middlewareValidationResult = {};
    if (validationMiddleware) {
      middlewareValidationResult = validationMiddleware(
        values,
        this.props.schema.schema
      ) || {};
    }

    return createErrorBlock(middlewareValidationResult);
  }

  /**
   * Common functionality for building a Field or Action from schema.
   *
   * @param {Object} props Props which every form field receives. Leave it up to the
   *        schema and component to determine which props are required.
   * @returns {*}
   */
  buildComponent(props) {
    // Inline `input` props into main field props
    // (each component can pick and choose the props required for it's <input>
    // See http://redux-form.com/6.0.5/docs/api/Field.md/#input-props
    const inputProps = props.input || {};
    const componentProps = {
      ...props,
      ...props.input,
      onChange: inputProps.onChange
        ? (event, payload) => {
          inputProps.onChange(payload ? payload.value : event);
        }
        : null,
    };
    delete componentProps.input;

    // 'component' key is renamed to 'schemaComponent' in normalize*() methods
    const SchemaComponent = this.getComponent(componentProps);

    if (SchemaComponent === null) {
      return null;
    } else if (componentProps.schemaComponent !== null && SchemaComponent === undefined) {
      throw Error(`Component not found in injector: ${componentProps.schemaComponent}`);
    }


    // Provides container components a place to hook in
    // and apply customisations to scaffolded components.
    const createFn = this.props.createFn;
    if (typeof createFn === 'function') {
      return createFn(SchemaComponent, componentProps);
    }
    return <SchemaComponent key={componentProps.id} {...componentProps} />;
  }

  /**
   * Maps a list of schema fields to their React Component.
   * Only top level form fields are handled here, composite fields (TabSets etc),
   * are responsible for mapping and rendering their children.
   *
   * @param {Array} fields
   * @return {Array}
   */
  mapFieldsToComponents(fields) {
    const FieldComponent = this.props.baseFieldComponent;
    return fields.map((field) => {
      let props = field;
      if (field.children) {
        props = Object.assign(
          {},
          field,
          { children: this.mapFieldsToComponents(field.children) }
        );
      }
      props = Object.assign(
        {
          onAutofill: this.props.onAutofill,
          formid: this.props.form,
        },
        props
      );

      // Don't wrap structural or readonly fields, since they don't need connected fields.
      // The redux-form connected fields also messed up reactstrap's tab handling.
      if (field.schemaType === 'Structural' || field.readOnly === true) {
        return this.buildComponent(props);
      }

      return <FieldComponent key={props.id} {...props} component={this.buildComponent} />;
    });
  }

  /**
   * When the action is clicked on, records which action was clicked on
   * This can allow for preventing the submit action, such as a custom action for the button
   *
   * @param {Event} event
   */
  handleAction(event) {
    // Custom handlers
    if (typeof this.props.onAction === 'function') {
      this.props.onAction(event, this.props.values);
    }

    // Allow custom handlers to cancel event
    if (!event.isPropagationStopped()) {
      this.setState({ submittingAction: event.currentTarget.name });
    }
  }

  /**
   * Form submission handler passed to the Form Component as a prop.
   * Provides a hook for controllers to access for state and provide custom functionality.
   *
   * @param {Object} data Processed and validated data from redux-form
   * (originally retrieved through schemaFieldValues())
   * @return {Promise|null}
   */
  handleSubmit(data) {
    // Add form action data (or default to first action, same as browser behaviour)
    let action = '';
    if (this.state.submittingAction) {
      action = this.state.submittingAction;
    } else if (this.props.schema.schema.actions[0]) {
      action = this.props.schema.schema.actions[0].name;
    }

    const dataWithAction = Object.assign({}, data, action ? { [action]: 1 } : {});
    const requestedSchema = this.props.responseRequestedSchema.join();
    const headers = {
      'X-Formschema-Request': requestedSchema,
      'X-Requested-With': 'XMLHttpRequest',
    };

    const submitFn = (customData) =>
      this.submitApi(customData || dataWithAction, headers)
        .then(formSchema => {
          this.setState({ submittingAction: null });
          return formSchema;
        })
        .catch((reason) => {
          // @todo Generic CMS error reporting
          this.setState({ submittingAction: null });
          throw reason;
        });

    if (typeof this.props.onSubmit === 'function') {
      return this.props.onSubmit(dataWithAction, action, submitFn);
    }

    return submitFn();
  }

  /**
   * Maps a list of form actions to their React Component.
   *
   * @param {Array} actions
   * @return {Array}
   */
  mapActionsToComponents(actions) {
    return actions.map((action) => {
      const props = Object.assign({}, action);

      if (action.children) {
        props.children = this.mapActionsToComponents(action.children);
      } else {
        props.onClick = this.handleAction;

        // Reset component loading prop
        if (this.props.submitting && this.state.submittingAction === action.name) {
          props.loading = true;
        }
      }

      return this.buildComponent(props);
    });
  }

  /**
   * If there is structural and state data available merge those data for each field.
   * Otherwise just use the structural data. Ensure that keys don't conflict
   * with redux-form expectations.
   *
   * @param {array} fields
   * @param {Object} state Optional
   * @return {array}
   */
  normalizeFields(fields, state) {
    return fields.map((field) => {
      const fieldState = (state && state.fields)
        ? state.fields.find((item) => item.id === field.id)
        : {};
      const data = merge.recursive(
        true,
        schemaMerge(field, fieldState),
        // Overlap with redux-form prop handling : createFieldProps filters out the 'component' key
        {
          schemaComponent: (fieldState && fieldState.component)
            ? fieldState.component
            : field.component,
        }
      );
      if (field.children) {
        data.children = this.normalizeFields(field.children, state);
      }

      return data;
    });
  }

  render() {
    const schema = this.props.schema.schema;
    const state = this.props.schema.state;
    const BaseFormComponent = this.props.baseFormComponent;

    // Map form schema to React component attribute names,
    // which requires renaming some of them (by unsetting the original keys)
    const attributes = {
      ...schema.attributes,
      className: schema.attributes.class,
      encType: schema.attributes.enctype,
      // Turn off HTML5 validation to rely on validateForm as the sole validator
      noValidate: true,
    };
    delete attributes.class;
    delete attributes.enctype;

    const {
      asyncValidate,
      fieldHolder,
      actionHolder,
      onSubmitFail,
      onSubmitSuccess,
      shouldAsyncValidate,
      touchOnBlur,
      touchOnChange,
      persistentSubmitErrors,
      form,
      afterMessages,
      autoFocus,
      formTag,
    } = this.props;

    const props = {
      form, // required as redux-form identifier
      afterMessages,
      fields: this.normalizeFields(schema.fields, state),
      fieldHolder,
      actions: this.normalizeFields(schema.actions, state),
      actionHolder,
      attributes,
      data: schema.data,
      initialValues: schemaFieldValues(schema, state),
      onSubmit: this.handleSubmit,
      valid: state && state.valid,
      messages: (state && Array.isArray(state.messages)) ? state.messages : [],
      mapActionsToComponents: this.mapActionsToComponents,
      mapFieldsToComponents: this.mapFieldsToComponents,
      asyncValidate,
      onSubmitFail,
      onSubmitSuccess,
      shouldAsyncValidate,
      touchOnBlur,
      touchOnChange,
      persistentSubmitErrors,
      validate: this.validateForm,
      autoFocus,
      setDOM: (formDOM) => { this.formDOM = formDOM; },
      formTag,
    };

    return (
      <BaseFormComponent
        {...props}
      />
    );
  }
}

const schemaPropType = PropTypes.shape({
  id: PropTypes.string,
  schema: PropTypes.shape({
    attributes: PropTypes.shape({
      class: PropTypes.string,
      enctype: PropTypes.string,
    }),
    fields: PropTypes.array.isRequired,
  }),
  state: PropTypes.shape({
    fields: PropTypes.array,
  }),
  loading: PropTypes.bool,
  stateOverride: PropTypes.shape({
    fields: PropTypes.array,
  }),
});

const basePropTypes = {
  createFn: PropTypes.func,
  onSubmit: PropTypes.func,
  onAction: PropTypes.func,
  asyncValidate: PropTypes.func,
  onSubmitFail: PropTypes.func,
  onSubmitSuccess: PropTypes.func,
  shouldAsyncValidate: PropTypes.func,
  touchOnBlur: PropTypes.bool,
  touchOnChange: PropTypes.bool,
  persistentSubmitErrors: PropTypes.bool,
  validate: PropTypes.func,
  values: PropTypes.object,
  submitting: PropTypes.bool,
  baseFormComponent: PropTypes.elementType.isRequired,
  baseFieldComponent: PropTypes.elementType.isRequired,
  getCustomFields: PropTypes.func,
  responseRequestedSchema: PropTypes.arrayOf(PropTypes.oneOf([
    'schema', 'state', 'errors', 'auto',
  ])),
  identifier(props, propName, componentName) {
    if (!/^[A-Za-z0-9_.]+$/.test(props[propName])) {
      return new Error(`
        Invalid identifier supplied to ${componentName}. Must be a set of
        dot-separated alphanumeric strings.
      `);
    }

    return null;
  },

};

FormBuilder.propTypes = Object.assign({}, basePropTypes, {
  form: PropTypes.string.isRequired,
  schema: schemaPropType.isRequired,
  autoFocus: PropTypes.bool,
});

FormBuilder.defaultProps = {
  responseRequestedSchema: ['auto'],
  autoFocus: false,
};

export {
  FormBuilder as Component,
  basePropTypes,
  schemaPropType
};
export default withInjector(FormBuilder);
