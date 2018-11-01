/**
 * File: LeftAndMain.js
 */
import $ from 'jquery';
import React from 'react';
import ReactDOM from 'react-dom';
import IframeDialog from 'components/IframeDialog/IframeDialog';
import Search from 'components/Search/Search';
import Loading from 'components/Loading/Loading';
import { schemaMerge } from 'lib/schemaFieldValues';
import { loadComponent } from 'lib/Injector';

require('../legacy/ssui.core.js');

$.noConflict();

window.ss = window.ss || {};

/**
 * @func debounce
 * @param func {function} - The callback to invoke after `wait` milliseconds.
 * @param wait {number} - Milliseconds to wait.
 * @param immediate {boolean} - If true the callback will be invoked at the start rather than the end.
 * @return {function}
 * @desc Returns a function that will not be called until it hasn't been invoked for `wait` seconds.
 */
window.ss.debounce = function (func, wait, immediate) {
  var timeout, context, args;

  var later = function() {
    timeout = null;
    if (!immediate) func.apply(context, args);
  };

  return function() {
    var callNow = immediate && !timeout;

    context = this;
    args = arguments;

    clearTimeout(timeout);
    timeout = setTimeout(later, wait);

    if (callNow) {
      func.apply(context, args);
    }
  };
};

$(window).bind('resize.leftandmain', function(e) {
  $('.cms-container').trigger('windowresize');
});

// setup jquery.entwine
$.entwine.warningLevel = $.entwine.WARN_LEVEL_BESTPRACTISE;

$.entwine('ss', function($) {

  /*
   * Handle messages sent via nested iframes
   * Messages should be raised via postMessage with an object with the 'type' parameter given.
   * An optional 'target' and 'data' parameter can also be specified. If no target is specified
   * events will be sent to the window instead.
   * type should be one of:
   *  - 'event' - Will trigger the given event (specified by 'event') on the target
   *  - 'callback' - Will call the given method (specified by 'callback') on the target
   */
  $(window).on("message", function(e) {
    var target,
      event = e.originalEvent,
      data = null;

    try
    {
        data = typeof event.data === 'object' ? event.data : JSON.parse(event.data);
    }
    catch(e)
    {
        // Invalid json received
    }

    // Reject invalid data or messages outside of the same origin
    if(!data || $.path.parseUrl(window.location.href).domain !== $.path.parseUrl(event.origin).domain) return;

    // Get target of this action
    target = typeof(data.target) === 'undefined'
      ? $(window)
      : $(data.target);

    // Determine action
    switch(data.type) {
      case 'event':
        target.trigger(data.event, data.data);
        break;
      case 'callback':
        target[data.callback].call(target, data.data);
        break;
    }
  });

  /**
   * Position the loading spinner animation below the ss logo
   */
  var positionLoadingSpinner = function() {
    var offset = 120; // offset from the ss logo
    var spinner = $('.ss-loading-screen .loading-animation');
    var top = ($(window).height() - spinner.height()) / 2;
    spinner.css('top', top + offset);
    spinner.show();
  };

  // apply an select element only when it is ready, ie. when it is rendered into a template
  // with css applied and got a width value.
  var applyChosen = function(el) {
    if(el.is(':visible')) {
      el.addClass('has-chosen').chosen({
        allow_single_deselect: true,
        disable_search_threshold: 20,
        display_disabled_options: true,
        width: '100%'
      });
    } else {
      setTimeout(function() {
        // Make sure it's visible before applying the ui
        el.show();
        applyChosen(el);
      }, 500);
    }
  };

  /**
   * Compare URLs, but normalize trailing slashes in
   * URL to work around routing weirdnesses in SS_HTTPRequest.
   * Also normalizes relative URLs by prefixing them with the <base>.
   */
  var isSameUrl = function(url1, url2) {
    var baseUrl = $('base').attr('href');
    url1 = $.path.isAbsoluteUrl(url1) ? url1 : $.path.makeUrlAbsolute(url1, baseUrl),
    url2 = $.path.isAbsoluteUrl(url2) ? url2 : $.path.makeUrlAbsolute(url2, baseUrl);
    var url1parts = $.path.parseUrl(url1), url2parts = $.path.parseUrl(url2);
    return (
      url1parts.pathname.replace(/\/*$/, '') == url2parts.pathname.replace(/\/*$/, '') &&
      url1parts.search == url2parts.search
    );
  };

  var ajaxCompleteEvent = window.ss.debounce(function () {
    $(window).trigger('ajaxComplete');
  }, 1000, true);

  $(window).bind('resize', positionLoadingSpinner).trigger('resize');

  // global ajax handlers
  $(document).ajaxComplete(function(e, xhr, settings) {
    // Simulates a redirect on an ajax response.
    var origUrl = document.URL,
      url = xhr.getResponseHeader('X-ControllerURL'),
      destUrl = settings.url,
      msg = xhr.getResponseHeader('X-Status') !== null ? xhr.getResponseHeader('X-Status') : xhr.statusText, // Handle custom status message headers
      msgType = (xhr.status < 200 || xhr.status > 399) ? 'bad' : 'good',
      ignoredMessages = ['OK', 'success', 'HTTP/2.0 200'];

    // Only redirect if controller url differs to the requested or current one
    if (url !== null && (!isSameUrl(origUrl, url) || !isSameUrl(destUrl, url))) {
      window.ss.router.show(url, {
        id: (new Date()).getTime() + String(Math.random()).replace(/\D/g,''), // Ensure that redirections are followed through by history API by handing it a unique ID
        pjax: xhr.getResponseHeader('X-Pjax') ? xhr.getResponseHeader('X-Pjax') : settings.headers['X-Pjax']
      });
    }

    // Enable reauthenticate dialog if requested
    if (xhr.getResponseHeader('X-Reauthenticate')) {
      $('.cms-container').showLoginDialog();
      return;
    }

    // Show message (but ignore aborted requests)
    if (xhr.status !== 0 && msg && $.inArray(msg, ignoredMessages) === -1) {
      // Decode into UTF-8, HTTP headers don't allow multibyte
      statusMessage(decodeURIComponent(msg), msgType);
    }

    ajaxCompleteEvent(this);
  });

  /**
   * Main LeftAndMain interface with some control panel and an edit form.
   *
   * Events:
   *  ajaxsubmit - ...
   *  validate - ...
   *  aftersubmitform - ...
   */
  $('.cms-container').entwine({

    /**
     * Tracks current panel request.
     */
    StateChangeXHR: null,

    /**
     * Tracks current fragment-only parallel PJAX requests.
     */
    FragmentXHR: {},

    StateChangeCount: 0,

    /**
     * Options for the threeColumnCompressor layout algorithm.
     *
     * See LeftAndMain.Layout.js for description of these options.
     */
    LayoutOptions: {
      minContentWidth: 940,
      minPreviewWidth: 400,
      mode: 'content'
    },

    /**
     * Constructor: onmatch
     */
    onadd: function() {
      // Browser detection
      if($.browser.msie && parseInt($.browser.version, 10) < 8) {
        $('.ss-loading-screen').append(
          '<p class="ss-loading-incompat-warning"><span class="notice">' +
          'Your browser is not compatible with the CMS interface. Please use Internet Explorer 8+, Google Chrome or Mozilla Firefox.' +
          '</span></p>'
        ).css('z-index', $('.ss-loading-screen').css('z-index')+1);
        $('.loading-animation').remove();

        this._super();
        return;
      }

      // Initialize layouts
      this.redraw();

      // Remove loading screen
      $('.ss-loading-screen').hide();
      $('body').removeClass('loading');
      $(window).unbind('resize', positionLoadingSpinner);
      this.restoreTabState();
      this._super();
    },

    'onwindowresize': function() {
      this.redraw();
    },

    'from .cms-panel': {
      ontoggle: function(){ this.redraw(); }
    },

    'from .cms-container': {
      onaftersubmitform: function(){ this.redraw(); }
    },

    /**
     * Change the options of the threeColumnCompressor layout, and trigger layouting if needed.
     * You can provide any or all options. The remaining options will not be changed.
     */
    updateLayoutOptions: function(newSpec) {
      var spec = this.getLayoutOptions();

      var dirty = false;

      for (var k in newSpec) {
        if (spec[k] !== newSpec[k]) {
          spec[k] = newSpec[k];
          dirty = true;
        }
      }

      if (dirty) this.redraw();
    },

    clearViewMode: function () {
      this.removeClass('cms-container--split-mode');
      this.removeClass('cms-container--preview-mode');
      this.removeClass('cms-container--content-mode');
    },

    /**
     * Enable the split view - with content on the left and preview on the right.
     */
    splitViewMode: function() {
      this.updateLayoutOptions({
        mode: 'split'
      });
    },

    /**
     * Content only.
     */
    contentViewMode: function() {
      this.updateLayoutOptions({
        mode: 'content'
      });
    },

    /**
     * Preview only.
     */
    previewMode: function() {
      this.updateLayoutOptions({
        mode: 'preview'
      });
    },

    RedrawSuppression: false,

    redraw: function() {
      if (this.getRedrawSuppression()) return;

      if(window.debug) console.log('redraw', this.attr('class'), this.get(0));

      // disable split mode if screen is too small
      var changed = this.setProperMode();

      // if changed, then the changing would trigger a redraw, so we don't want to redraw twice
      if (!changed) {
        // Redraw on all the children that need it
        this.find('.cms-panel-layout').redraw();
        this.find('.cms-content-fields[data-layout-type]').redraw();
        this.find('.cms-edit-form[data-layout-type]').redraw();
        this.find('.cms-preview').redraw();
        this.find('.cms-content').redraw();
      }
    },

    /**
     * Changes the viewing mode if the screen is too small, disables split mode.
     *
     * @returns {boolean} changedMode - so redraw is not called twice
     */
    setProperMode: function () {
      var options = this.getLayoutOptions();
      var mode = options.mode;
      this.clearViewMode();

      var content = this.find('.cms-content');
      var preview = this.find('.cms-preview');

      content.css({'min-width': 0});
      preview.css({'min-width': 0});

      if (content.width() + preview.width() >= options.minContentWidth + options.minPreviewWidth) {
        content.css({'min-width': options.minContentWidth});
        preview.css({'min-width': options.minPreviewWidth});
        preview.trigger('enable');
      } else {
        preview.trigger('disable');
        if (mode == 'split') {
          // force change mode and leave it redraw after
          preview.trigger('forcecontent');
          return true;
        }
      }

      this.addClass('cms-container--' + mode + '-mode');
      return false;
    },

    /**
     * Confirm whether the current user can navigate away from this page
     *
     * @param {array} selectors Optional list of selectors
     * @returns {boolean} True if the navigation can proceed
     */
    checkCanNavigate: function(selectors) {
      // Check change tracking (can't use events as we need a way to cancel the current state change)
      var contentEls = this._findFragments(selectors || ['Content']),
        trackedEls = contentEls
          .find(':data(changetracker)')
          .add(contentEls.filter(':data(changetracker)')),
        safe = true;

      if(!trackedEls.length) {
        return true;
      }

      trackedEls.each(function() {
        // See LeftAndMain.EditForm.js
        if(!$(this).confirmUnsavedChanges()) {
          safe = false;
        }
      });

      return safe;
    },

    /**
     * @param {String} url
     * @param {String} title New window title.
     * @param {Object} data Any additional data passed through to `window.history.state`.
     * @param {Boolean} forceReload Forces the replacement of the current history state, even if the URL is the same, i.e. allows reloading.
     * @param {String} forceReferer
     */
    loadPanel: function (url, title = '', data = {}, forceReload, forceReferer = document.URL) {
      // Check for unsaved changes
      if (!this.checkCanNavigate(data.pjax ? data.pjax.split(',') : ['Content'])) {
        return;
      }

      this.saveTabState();

      data.__forceReferer = forceReferer;

      if (forceReload) {
        data.__forceReload = 1 + Math.random(); // Make sure the page reloads even if the URL is the same.
      }

      window.ss.router.show(url, data);
    },

    /**
     * Nice wrapper for reloading current history state.
     */
    reloadCurrentPanel: function() {
      this.loadPanel(document.URL, null, null, true);
    },

    /**
     * Function: submitForm
     *
     * Parameters:
     *  {DOMElement} form - The form to be submitted. Needs to be passed
     *   in to avoid entwine methods/context being removed through replacing the node itself.
     *  {DOMElement} button - The pressed button (optional)
     *  {Function} callback - Called in complete() handler of jQuery.ajax()
     *  {Object} ajaxOptions - Object literal to merge into $.ajax() call
     *
     * Returns:
     *  (boolean)
     */
    submitForm: function(form, button, callback, ajaxOptions) {
      var self = this;

      // look for save button
      if(!button) button = this.find('.btn-toolbar :submit[name=action_save]');
      // default to first button if none given - simulates browser behaviour
      if(!button) button = this.find('.btn-toolbar :submit:first');

      form.trigger('beforesubmitform');
      this.trigger('submitform', {form: form, button: button});

      // set button to "submitting" state
      $(button).addClass('btn--loading loading');

      if($(button).is('button')) {
        $(button).data('original-text', $(button).text());

        $(button).append($(
          '<div class="btn__loading-icon">'+
            '<span class="btn__circle btn__circle--1" />'+
            '<span class="btn__circle btn__circle--2" />'+
            '<span class="btn__circle btn__circle--3" />'+
          '</div>'));

        $(button).css($(button).outerWidth() + 'px');
      }

      // validate if required
      var validationResult = form.validate();

      var clearButton = function() {
        $(button).removeClass('btn--loading loading');
        $(button).find('.btn__loading-icon').remove();
        $(button).css('width', 'auto');
        $(button).text($(button).data('original-text'));
      }

      if(typeof validationResult!=='undefined' && !validationResult) {
        // TODO Automatically switch to the tab/position of the first error
        statusMessage("Validation failed.", "bad");
        clearButton();
      }

      // get all data from the form
      var formData = form.serializeArray();
      // add button action
      formData.push({name: $(button).attr('name'), value:'1'});
      // Artificial HTTP referer, IE doesn't submit them via ajax.
      // Also rewrites anchors to their page counterparts, which is important
      // as automatic browser ajax response redirects seem to discard the hash/fragment.
      // TODO Replaces trailing slashes added by History after locale (e.g. admin/?locale=en/)
      formData.push({ name: 'BackURL', value: document.URL.replace(/\/$/, '') });

      // Save tab selections so we can restore them later
      this.saveTabState();


      // Standard Pjax behaviour is to replace the submitted form with new content.
      // The returned view isn't always decided upon when the request
      // is fired, so the server might decide to change it based on its own logic,
      // sending back different `X-Pjax` headers and content
      jQuery.ajax(jQuery.extend({
        headers: {"X-Pjax" : "CurrentForm,Breadcrumbs"},
        url: form.attr('action'),
        data: formData,
        type: 'POST',
        complete: function() {
          clearButton()
        },
        success: function(data, status, xhr) {
          clearButton();
          form.removeClass('changed'); // TODO This should be using the plugin API
          if(callback) callback(data, status, xhr);

          var newContentEls = self.handleAjaxResponse(data, status, xhr);
          if(!newContentEls) return;

          newContentEls.filter('form').trigger('aftersubmitform', {status: status, xhr: xhr, formData: formData});
        }
      }, ajaxOptions));

      return false;
    },

    /**
     * Last html5 history state
     */
    LastState: null,

    /**
     * Flag to pause handleStateChange
     */
    PauseState: false,

    /**
     * Handles ajax loading of new panels through the window.history object.
     * To trigger loading, pass a new URL to window.ss.router.show().
     * Use loadPanel() as a window.ss.router.show() wrapper as it provides some
     * additional functionality like global changetracking and user aborts.
     *
     * Due to the nature of history management, no callbacks are allowed.
     * Use the 'beforestatechange' and 'afterstatechange' events instead,
     * or overwrite the beforeLoad() and afterLoad() methods on the
     * DOM element you're loading the new content into.
     * Although you can pass data into window.ss.router.show(url, data), it
     * shouldn't contain DOM elements or callback closures.
     *
     * The passed URL should allow reconstructing important interface state
     * without additional parameters, in the following use cases:
     * - Explicit loading through window.ss.router.show()
     * - Implicit loading through browser navigation event triggered by the user
     *   (forward or back).
     * - Full window refresh without ajax
     * For example, a ModelAdmin search event should contain the search terms
     * as URL parameters, and the result display should automatically appear
     * if the URL is loaded without ajax.
     */
    handleStateChange: function (event, historyState = window.history.state) {
      if (this.getPauseState()) {
        return;
      }

      // Don't allow parallel loading to avoid edge cases
      if (this.getStateChangeXHR()) {
        this.getStateChangeXHR().abort();
      }

      var self = this,
        fragments = historyState.pjax || 'Content',
        headers = {},
        fragmentsArr = fragments.split(','),
        contentEls = this._findFragments(fragmentsArr);

      this.setStateChangeCount(this.getStateChangeCount() + 1);

      if (!this.checkCanNavigate()) {
        var lastState = this.getLastState();

        // Suppress panel loading while resetting state
        this.setPauseState(true);

        // Restore best last state
        if (lastState && lastState.path) {
          window.ss.router.show(lastState.path);
        } else {
          window.ss.router.back();
        }

        this.setPauseState(false);

        // Abort loading of this panel
        return;
      }

      this.setLastState(historyState);

      // If any of the requested Pjax fragments don't exist in the current view,
      // fetch the "Content" view instead, which is the "outermost" fragment
      // that can be reloaded without reloading the whole window.
      if (contentEls.length < fragmentsArr.length) {
        fragments = 'Content', fragmentsArr = ['Content'];
        contentEls = this._findFragments(fragmentsArr);
      }

      this.trigger('beforestatechange', { state: historyState, element: contentEls });

      // Set Pjax headers, which can declare a preference for the returned view.
      // The actually returned view isn't always decided upon when the request
      // is fired, so the server might decide to change it based on its own logic.
      headers['X-Pjax'] = fragments;

      if (typeof historyState.__forceReferer !== 'undefined') {
        // Ensure query string is properly encoded if present
        let url = historyState.__forceReferer;

        try {
          // Prevent double-encoding by attempting to decode
          url = decodeURI(url);
        } catch(e) {
          // URL not encoded, or was encoded incorrectly, so do nothing
        } finally {
          // Set our referer header to the encoded URL
          headers['X-Backurl'] = encodeURI(url);
        }
      }

      contentEls.addClass('loading');

      let promise = $.ajax({
        headers: headers,
        url: historyState.path || document.URL
      })
      .done((data, status, xhr) => {
        var els = self.handleAjaxResponse(data, status, xhr, historyState);
        self.trigger('afterstatechange', {data: data, status: status, xhr: xhr, element: els, state: historyState});
      })
      .always(() => {
        self.setStateChangeXHR(null);
        // Remove loading indication from old content els (regardless of which are replaced)
        contentEls.removeClass('loading');
      });

      this.setStateChangeXHR(promise);

      return promise;
    },

    /**
     * ALternative to loadPanel/submitForm.
     *
     * Triggers a parallel-fetch of a PJAX fragment, which is a separate request to the
     * state change requests. There could be any amount of these fetches going on in the background,
     * and they don't register as a HTML5 history states.
     *
     * This is meant for updating a PJAX areas that are not complete panel/form reloads. These you'd
     * normally do via submitForm or loadPanel which have a lot of automation built in.
     *
     * On receiving successful response, the framework will update the element tagged with appropriate
     * data-pjax-fragment attribute (e.g. data-pjax-fragment="<pjax-fragment-name>"). Make sure this element
     * is available.
     *
     * Example usage:
     * $('.cms-container').loadFragment('admin/foobar/', 'FragmentName');
     *
     * @param url string Relative or absolute url of the controller.
     * @param pjaxFragments string PJAX fragment(s), comma separated.
     */
    loadFragment: function(url, pjaxFragments) {

      var self = this,
        xhr,
        headers = {},
        baseUrl = $('base').attr('href'),
        fragmentXHR = this.getFragmentXHR();

      // Make sure only one XHR for a specific fragment is currently in progress.
      if(
        typeof fragmentXHR[pjaxFragments]!=='undefined' &&
        fragmentXHR[pjaxFragments]!==null
      ) {
        fragmentXHR[pjaxFragments].abort();
        fragmentXHR[pjaxFragments] = null;
      }

      url = $.path.isAbsoluteUrl(url) ? url : $.path.makeUrlAbsolute(url, baseUrl);
      headers['X-Pjax'] = pjaxFragments;

      xhr = $.ajax({
        headers: headers,
        url: url,
        success: function(data, status, xhr) {
          var elements = self.handleAjaxResponse(data, status, xhr, null);

          // We are fully done now, make it possible for others to hook in here.
          self.trigger('afterloadfragment', { data: data, status: status, xhr: xhr, elements: elements });
        },
        error: function(xhr, status, error) {
          self.trigger('loadfragmenterror', { xhr: xhr, status: status, error: error });
        },
        complete: function() {
          // Reset the current XHR in tracking object.
          var fragmentXHR = self.getFragmentXHR();
          if(
            typeof fragmentXHR[pjaxFragments]!=='undefined' &&
            fragmentXHR[pjaxFragments]!==null
          ) {
            fragmentXHR[pjaxFragments] = null;
          }
        }
      });

      // Store the fragment request so we can abort later, should we get a duplicate request.
      fragmentXHR[pjaxFragments] = xhr;

      return xhr;
    },

    /**
     * Handles ajax responses containing plain HTML, or mulitple
     * PJAX fragments wrapped in JSON (see PjaxResponseNegotiator PHP class).
     * Can be hooked into an ajax 'success' callback.
     *
     * Parameters:
     *   (Object) data
     *   (String) status
     *   (XMLHTTPRequest) xhr
     *   (Object) state The original history state which the request was initiated with
     */
    handleAjaxResponse: function(data, status, xhr, state) {
      var self = this, url, selectedTabs, guessFragment, fragment, $data;

      // Support a full reload
      if(xhr.getResponseHeader('X-Reload') && xhr.getResponseHeader('X-ControllerURL')) {
        var baseUrl = $('base').attr('href'),
          rawURL = xhr.getResponseHeader('X-ControllerURL'),
          url = $.path.isAbsoluteUrl(rawURL) ? rawURL : $.path.makeUrlAbsolute(rawURL, baseUrl);

        document.location.href = url;
        return;
      }

      // Pseudo-redirects via X-ControllerURL might return empty data, in which
      // case we'll ignore the response
      if(!data) return;

      // Update title
      var title = xhr.getResponseHeader('X-Title');
      if(title) document.title = decodeURIComponent(title.replace(/\+/g, ' '));

      var newFragments = {}, newContentEls;
      // If content type is application/json (ignoring charset and other parameters)
      if(xhr.getResponseHeader('Content-Type').match(/^((text)|(application))\/json[ \t]*;?/i)) {
        newFragments = data;
      } else {

        // Fall back to replacing the content fragment if HTML is returned
        fragment = document.createDocumentFragment();

        jQuery.clean( [ data ], document, fragment, [] );
        $data = $(jQuery.merge( [], fragment.childNodes ));

        // Try and guess the fragment if none is provided
        // TODO: data-pjax-fragment might actually give us the fragment. For now we just check most common case
        guessFragment = 'Content';
        if ($data.is('form') && !$data.is('[data-pjax-fragment~=Content]')) guessFragment = 'CurrentForm';

        newFragments[guessFragment] = $data;
      }

      this.setRedrawSuppression(true);
      try {
        // Replace each fragment individually
        $.each(newFragments, function (newFragment, html) {
          var contentEl = $('[data-pjax-fragment]').filter(function () {
              return $.inArray(newFragment, $(this).data('pjaxFragment').split(' ')) != -1;
            }),
            newContentEl = $(html);

          // Add to result collection
          if(newContentEls) newContentEls.add(newContentEl);
          else newContentEls = newContentEl;

          // Update panels
          if(newContentEl.find('.cms-container').length) {
            throw 'Content loaded via ajax is not allowed to contain tags matching the ".cms-container" selector to avoid infinite loops';
          }

          // Set loading state and store element state
          var origStyle = contentEl.attr('style');
          var origParent = contentEl.parent();
          var layoutClasses = ['east', 'west', 'center', 'north', 'south', 'column-hidden'];
          var elemClasses = contentEl.attr('class');
          var origLayoutClasses = [];
          if(elemClasses) {
            origLayoutClasses = $.grep(
              elemClasses.split(' '),
              function(val) { return ($.inArray(val, layoutClasses) >= 0);}
            );
          }

          newContentEl
            .removeClass(layoutClasses.join(' '))
            .addClass(origLayoutClasses.join(' '));
          if(origStyle) newContentEl.attr('style', origStyle);

          // Allow injection of inline styles, as they're not allowed in the document body.
          // Not handling this through jQuery.ondemand to avoid parsing the DOM twice.
          var styles = newContentEl.find('style').detach();
          if(styles.length) $(document).find('head').append(styles);

          // Replace panel completely (we need to override the "layout" attribute, so can't replace the child instead)
          contentEl.replaceWith(newContentEl);

        });

        // Re-init tabs (in case the form tag itself is a tabset)
        var newForm = newContentEls.filter('form');
        if(newForm.hasClass('cms-tabset')) newForm.removeClass('cms-tabset').addClass('cms-tabset');
      }
      finally {
        this.setRedrawSuppression(false);
      }

      this.redraw();
      this.restoreTabState((state && typeof state.tabState !== 'undefined') ? state.tabState : null);

      return newContentEls;
    },

    /**
     *
     *
     * Parameters:
     * - fragments {Array}
     * Returns: jQuery collection
     */
    _findFragments: function(fragments) {
      return $('[data-pjax-fragment]').filter(function() {
        // Allows for more than one fragment per node
        var i, nodeFragments = $(this).data('pjaxFragment').split(' ');
        for(i in fragments) {
          if($.inArray(fragments[i], nodeFragments) != -1) return true;
        }
        return false;
      });
    },

    /**
     * Function: refresh
     *
     * Updates the container based on the current url
     *
     * Returns: void
     */
    refresh: function() {
      $(window).trigger('statechange');

      $(this).redraw();
    },

    /**
     * Save tab selections in order to reconstruct them later.
     * Requires HTML5 sessionStorage support.
     */
    saveTabState: function() {
      if(typeof(window.sessionStorage)=="undefined" || window.sessionStorage === null) return;

      var selectedTabs = [], url = this._tabStateUrl();
      this.find('.cms-tabset,.ss-tabset').each(function(i, el) {
        var id = $(el).attr('id');
        if(!id) return; // we need a unique reference
        if(!$(el).data('tabs')) return; // don't act on uninit'ed controls

        // Allow opt-out via data element or entwine property.
        if($(el).data('ignoreTabState') || $(el).getIgnoreTabState()) return;

        selectedTabs.push({id:id, selected:$(el).tabs('option', 'selected')});
      });

      if(selectedTabs) {
        var tabsUrl = 'tabs-' + url;
        try {
          window.sessionStorage.setItem(tabsUrl, JSON.stringify(selectedTabs));
        } catch(err) {
          if (err.code === DOMException.QUOTA_EXCEEDED_ERR && window.sessionStorage.length === 0) {
            // If this fails we ignore the error as the only issue is that it
            // does not remember the tab state.
            // This is a Safari bug which happens when private browsing is enabled.
            return;
          } else {
            throw err;
          }
        }
      }
    },

    /**
     * Re-select previously saved tabs.
     * Requires HTML5 sessionStorage support.
     *
     * Parameters:
     *   (Object) Map of tab container selectors to tab selectors.
     *   Used to mark a specific tab as active regardless of the previously saved options.
     */
    restoreTabState: function(overrideStates) {
      var self = this, url = this._tabStateUrl(),
        hasSessionStorage = (typeof(window.sessionStorage)!=="undefined" && window.sessionStorage),
        sessionData = hasSessionStorage ? window.sessionStorage.getItem('tabs-' + url) : null,
        sessionStates = sessionData ? JSON.parse(sessionData) : false;

      this.find('.cms-tabset, .ss-tabset').each(function() {
        var index, tab,
          tabset = $(this),
          tabsetId = tabset.attr('id'),
          forcedTab = tabset.children('ul').children('li.ss-tabs-force-active');

        if(!tabset.data('tabs')){
          return; // don't act on uninit'ed controls
        }

        // The tabs may have changed, notify the widget that it should update its internal state.
        tabset.tabs('refresh');

        // Make sure the intended tab is selected. Only force the tab on the correct tabset though
        if(forcedTab.length) {
          index = forcedTab.first().index();
        } else if(overrideStates && overrideStates[tabsetId]) {
          tab = tabset.find(overrideStates[tabsetId].tabSelector);
          if(tab.length){
            index = tab.index();
          }
        } else if(sessionStates) {
          $.each(sessionStates, function(i, state) {
            if(tabsetId == state.id) {
              index = state.selected;
            }
          });
        }
        if(index !== null){
          tabset.tabs('option', 'active', index);
          self.trigger('tabstaterestored');
        }
      });
    },

    /**
     * Remove any previously saved state.
     *
     * Parameters:
     *  (String) url Optional (sanitized) URL to clear a specific state.
     */
    clearTabState: function(url) {
      if(typeof(window.sessionStorage)=="undefined") return;

      var s = window.sessionStorage;
      if(url) {
        s.removeItem('tabs-' + url);
      } else {
        for(var i=0;i<s.length;i++) {
          if(s.key(i).match(/^tabs-/)) s.removeItem(s.key(i));
        }
      }
    },

    /**
     * Remove tab state for the current URL.
     */
    clearCurrentTabState: function() {
      this.clearTabState(this._tabStateUrl());
    },

    _tabStateUrl: function() {
      return window.location.href
        .replace(/\?.*/, '')
        .replace(/#.*/, '')
        .replace($('base').attr('href'), '');
    },

    showLoginDialog: function() {
      // Force regeneration of any existing dialog
      let dialog = $('.leftandmain__login-dialog');
      if (dialog.length) {
        dialog.destroy();
      }

      // Create container
      dialog = $('<div class="leftandmain__login-dialog" />');
      $('body').append(dialog);
      dialog.open();
    },
  });

  /**
   * Login dialog page
   * Selector must match string in CMSSecurity_success.ss message callback
  */
  $('.leftandmain__login-dialog').entwine({
    destroy() {
      this.close();
      this.remove();
    },
    close() {
      this.renderModal(false);
    },
    open() {
      this.renderModal(true);
    },

    renderModal(isOpen) {
      // Build properties
      const tempid = $('body').data('member-tempid');
      const url = $.path.addSearchParams('CMSSecurity/login', {
        tempid,
        BackURL: window.location.href,
      });

      ReactDOM.render(
        <IframeDialog
          title={i18n._t('Admin.CMS_LOGIN_TITLE', 'Login')}
          className="login-dialog"
          bodyClassName="login-dialog__body"
          iframeId="login-dialog-iframe"
          iframeClassName="login-dialog__body__iframe"
          isOpen={isOpen}
          url={url}
        />,
        this[0]
      );
    },

    /**
     * Callback activated by CMSSecurity_success.ss
     */
    reauthenticate(data) {
      // Replace all SecurityID fields with the given value
      if (typeof(data.SecurityID) !== 'undefined') {
        $(':input[name=SecurityID]').val(data.SecurityID);
      }
      // Update TempID for current user
      if (typeof(data.TempID) !== 'undefined') {
        $('body').data('member-tempid', data.TempID);
      }
      this.close();
    },
  });

  /**
   * Add loading overlay to selected regions in the CMS automatically.
   * Not applied to all "*.loading" elements to avoid secondary regions
   * like the breadcrumbs showing unnecessary loading status.
   */
  $('form.loading,.cms-content.loading,.cms-content-fields.loading,.cms-content-view.loading,.ss-gridfield-item.loading').entwine({
    onmatch: function() {
      this._super();
      ReactDOM.render(
        <Loading />,
        this[0]
      );
    },
    onunmatch: function() {
      this._super();
      const container = this[0];
      if (container) {
        ReactDOM.unmountComponentAtNode(container);
      }
    }
  });

  /**
   * Loads the link's 'href' attribute into a panel via ajax,
   * as opposed to triggering a full page reload.
   * Little helper to avoid repetition, and make it easy to
   * "opt in" to panel loading, while by default links still exhibit their default behaviour.
   * The PJAX target can be specified via a 'data-pjax-target' attribute.
   */
  $('.cms .cms-panel-link').entwine({
    onclick: function(e) {
      if($(this).hasClass('external-link')) {
        e.stopPropagation();

        return;
      }

      var href = this.attr('href'),
        url = (href && !href.match(/^#/)) ? href : this.data('href'),
        data = {pjax: this.data('pjaxTarget')};

      $('.cms-container').loadPanel(url, null, data);
      e.preventDefault();
    }
  });

  /**
   * Does an ajax loads of the link's 'href' attribute via ajax and displays any FormResponse messages from the CMS.
   * Little helper to avoid repetition, and make it easy to trigger actions via a link,
   * without reloading the page, changing the URL, or loading in any new panel content.
   */
  $('.cms .ss-ui-button-ajax').entwine({
    onclick: function(e) {
      $(this).removeClass('ui-button-text-only');
      $(this).addClass('ss-ui-button-loading ui-button-text-icons');

      var loading = $(this).find(".ss-ui-loading-icon");

      if(loading.length < 1) {
        loading = $("<span></span>").addClass('ss-ui-loading-icon ui-button-icon-primary ui-icon');

        $(this).prepend(loading);
      }

      loading.show();

      var href = this.attr('href'), url = href ? href : this.data('href');

      jQuery.ajax({
        url: url,
        // Ensure that form view is loaded (rather than whole "Content" template)
        complete: function(xmlhttp, status) {
          var msg = (xmlhttp.getResponseHeader('X-Status')) ? xmlhttp.getResponseHeader('X-Status') : xmlhttp.responseText;

          try {
            if (typeof msg != "undefined" && msg !== null) eval(msg);
          }
          catch(e) {}

          loading.hide();

          $(".cms-container").refresh();

          $(this).removeClass('ss-ui-button-loading ui-button-text-icons');
          $(this).addClass('ui-button-text-only');
        },
        dataType: 'html'
      });
      e.preventDefault();
    }
  });

  /**
   * Trigger dialogs with iframe based on the links href attribute (see ssui-core.js).
   */
  $('.cms .ss-ui-dialog-link').entwine({
    UUID: null,
    onmatch: function() {
      this._super();
      this.setUUID(new Date().getTime());
    },
    onunmatch: function() {
      this._super();
    },
    onclick: function() {
      this._super();

      var self = this, id = 'ss-ui-dialog-' + this.getUUID();
      var dialog = $('#' + id);
      if(!dialog.length) {
        dialog = $('<div class="ss-ui-dialog" id="' + id + '" />');
        $('body').append(dialog);
      }

      var extraClass = this.data('popupclass')?this.data('popupclass'):'';

      dialog.ssdialog({iframeUrl: this.attr('href'), autoOpen: true, dialogExtraClass: extraClass});
      return false;
    }
  });

  /**
   * Duplicates functionality in DateField.js, but due to using entwine we can match
   * the DOM element on creation, rather than onclick - which allows us to decorate
   * the field with a calendar icon
   */
  $('.cms .field.date input.text').entwine({
    onmatch: function() {
      var holder = $(this).parents('.field.date:first'), config = holder.data();
      if(!config.showcalendar) {
        this._super();
        return;
      }

      config.showOn = 'button';
      if(config.locale && $.datepicker.regional[config.locale]) {
        config = $.extend(config, $.datepicker.regional[config.locale], {});
      }

      if (!this.prop('disabled') && !this.prop('readonly')) {
        $(this).datepicker(config);
      }

      this._super();
    },
    onunmatch: function() {
      this._super();
    }
  });

  /**
   * Styled dropdown select fields via chosen. Allows things like search and optgroup
   * selection support. Rather than manually adding classes to selects we want
   * styled, we style everything but the ones we tell it not to.
   *
   * For the CMS we also need to tell the parent div that it has a select so
   * we can fix the height cropping.
   */
  $('.cms .field.dropdown select, .cms .field select[multiple], .form__fieldgroup-item select.dropdown').entwine({
    onmatch: function() {
      if(this.is('.no-chosen')) {
        this._super();
        return;
      }

      // Explicitly disable default placeholder if no custom one is defined
      if(!this.data('placeholder')) this.data('placeholder', ' ');

      // We could've gotten stale classes and DOM elements from deferred cache.
      this.removeClass('has-chosen').chosen("destroy");
      this.siblings('.chosen-container').remove();

      // Apply Chosen
      applyChosen(this);

      this._super();
    },
    onunmatch: function() {
      this._super();
    }
  });

  $(".cms-panel-layout").entwine({
    redraw: function() {
      if(window.debug) console.log('redraw', this.attr('class'), this.get(0));
    }
  });

  /**
   * Overload the default GridField behaviour (open a new URL in the browser)
   * with the CMS-specific ajax loading.
   *
   * To opt out of this overload by adding `cms-loading-ignore-url-params` html
   * attribute to the grid field.
   */
  $('.cms .grid-field:not([cms-loading-ignore-url-params])').entwine({
    showDetailView: function(url) {
      // Include any GET parameters from the current URL, as the view state might depend on it.
      // For example, a list prefiltered through external search criteria might be passed to GridField.
      var params = window.location.search.replace(/^\?/, '');
      if(params) url = $.path.addSearchParams(url, params);
      $('.cms-container').loadPanel(url);
    }
  });

  /**
   * Reset button handler. IE8 does not bubble reset events to
   */
  $(".cms-search-form button[type=reset], .cms-search-form input[type=reset]").entwine({
    onclick: function(e) {
      e.preventDefault();

      var form = $(this).parents('form');

      form.clearForm();
      form.find(".dropdown select").prop('selectedIndex', 0).trigger("chosen:updated"); // Reset chosen.js
      form.submit();
    }
  });

  /**
   * Allows to lazy load a panel, by leaving it empty
   * and declaring a URL to load its content via a 'url' HTML5 data attribute.
   * The loaded HTML is cached, with cache key being the 'url' attribute.
   * In order for this to work consistently, we assume that the responses are stateless.
   * To avoid caching, add a 'deferred-no-cache' to the node.
   */
  window._panelDeferredCache = {};
  $('.cms-panel-deferred').entwine({
    onadd: function() {
      this._super();
      this.redraw();
    },
    onremove: function() {
      if(window.debug) console.log('saving', this.data('url'), this);

      // Save the HTML state at the last possible moment.
      // Don't store the DOM to avoid memory leaks.
      if(!this.data('deferredNoCache')) window._panelDeferredCache[this.data('url')] = this.html();
      this._super();
    },
    redraw: function() {
      if(window.debug) console.log('redraw', this.attr('class'), this.get(0));

      var self = this, url = this.data('url');
      if(!url) throw 'Elements of class .cms-panel-deferred need a "data-url" attribute';

      this._super();

      if(!this.data('deferredNoCache') && typeof window._panelDeferredCache[url] !== 'undefined') {
        this.html(window._panelDeferredCache[url]);
      } else {
        this.addClass('loading');
        $.ajax({
          url: url,
          complete: function() {
            self.removeClass('loading');
          },
          success: function(data, status, xhr) {
            self.html(data);
          }
        });
      }
    }
  });

  /**
   * Lightweight wrapper around jQuery UI tabs.
   * Ensures that anchor links are set properly,
   * and any nested tabs are scrolled if they have
   * their height explicitly set. This is important
   * for forms inside the CMS layout.
   */
  $('.cms-tabset').entwine({
    onadd: function() {
      // Can't name redraw() as it clashes with other CMS entwine classes
      this.redrawTabs();
      this._super();
    },
    onremove: function() {
      if (this.data('tabs')) this.tabs('destroy');
      this._super();
    },
    redrawTabs: function() {
      this.rewriteHashlinks();

      var id = this.attr('id'), activeTab = this.find('ul:first .ui-tabs-active');

      if(!this.data('tabs')) this.tabs({
        active: (activeTab.index() != -1) ? activeTab.index() : 0,
        beforeLoad: function(e, ui) {
          // Disable automatic ajax loading of tabs without matching DOM elements,
          // determining if the current URL differs from the tab URL is too error prone.
          return false;
        },
        beforeActivate: function (e, ui) {
          var link = ui.oldTab.find('.cms-panel-link');

          // do not activate for panel link tabs
          if (link && link.length === 1) {
            return false;
          }
        },
        activate: function(e, ui) {
          // Usability: Hide actions for "readonly" tabs (which don't contain any editable fields)
          var actions = $(this).closest('form').find('.btn-toolbar');
          if($(ui.newTab).closest('li').hasClass('readonly')) {
            actions.fadeOut();
          } else {
            actions.show();
          }
        }
      });
      this.trigger('afterredrawtabs');
    },

    /**
     * Ensure hash links are prefixed with the current page URL,
     * otherwise jQuery interprets them as being external.
     */
    rewriteHashlinks: function() {
      $(this).find('ul a').each(function() {
        if (!$(this).attr('href')) return;
        var matches = $(this).attr('href').match(/#.*/);
        if(!matches) return;
        $(this).attr('href', document.location.href.replace(/#.*/, '') + matches[0]);
      });
    }
  });

  /**
   * CMS content filters
   */
  $('#filters-button').entwine({
    onmatch: function () {
      this._super();

      this.data('collapsed', true); // The current collapsed state of the element.
      this.data('animating', false); // True if the element is currently animating.
    },
    onunmatch: function () {
      this._super();
    },
    showHide: function () {
      var self = this,
        $filters = $('.cms-content-filters').first(),
        collapsed = this.data('collapsed');

      // previously using "slideDown"/"slideUp" jQuery, but it was causing issues
      if (collapsed) {
        this.addClass('active');
        $filters.removeClass('cms-content-filters--hidden');
      } else {
        this.removeClass('active');
        $filters.addClass('cms-content-filters--hidden');
      }
      self.data('collapsed', !collapsed);
    },
    onclick: function () {
      this.showHide();
    }
  });

  $('.js-injector-boot .search-holder').entwine({
    Component: null,

    onmatch() {
      this._super();

      const cmsContent = this.closest('.cms-content').attr('id');
      const context = (cmsContent)
        ? { context: cmsContent }
        : {};

      const Search = loadComponent('Search', context);
      this.setComponent(Search);

      this.refresh();

      const props = this.data('schema');
    },

    onunmatch() {
      this._super();
      // solves errors given by ReactDOM "no matched root found" error.
      const container = this[0];
      if (container) {
        ReactDOM.unmountComponentAtNode(container);
      }
    },

    // Prevent search filters form appearing below other elements
    onfocusin() {
      this.css('z-index', '100');
    },

    onfocusout() {
      this.css('z-index', '');
    },

    close() {
      $('#filters-button').showHide();
      const props = this.data('schema');

      if(props.filters) {
        const url = $('.cms-search-form').attr('action');
        const container = this.closest('.cms-container');
        container.loadPanel(url, "", {}, true);
      }
    },

    search(data) {
      this._super();
      let url = $('.cms-search-form').attr('action');

      if(url && data) {
        const params = [];
        for (const [key, value] of Object.entries(data)) {
          if (value) {
            params[`q[${key}]`] = value;
          }
        }
        if (Object.keys(params).length === 0) {
          params[`q[${this.data('schema').name}]`] = "";
        }
        url = $.path.addSearchParams(url, params);

        $('.cms-panel-deferred.cms-content-view').data('deferredNoCache', true);

        var container = this.closest('.cms-container');
        container.loadPanel(url, "", {}, true);
      }
    },

    refresh() {
      const props = this.data('schema');
      const Search = this.getComponent();
      const handleHide = () => this.close();
      const handleSearch = (data) => this.search(data);
      const narrowView = this.closest('.cms-content-tools').attr('id') === 'cms-content-tools-CMSMain';

      ReactDOM.render(
        <Search
          id="Search"
          identifier="Search"
          display="VISIBLE"
          displayBehavior={"HIDEABLE"}
          filterPrefix="Search__"
          onHide={handleHide}
          onSearch={handleSearch}
          borders={{
            left: !narrowView
          }}
          {...props}
        />,
        this[0]
      );
    },
  });
});

var statusMessage = function(text, type) {
  text = jQuery('<div/>').text(text).html(); // Escape HTML entities in text
  jQuery.noticeAdd({text: text, type: type, stayTime: 5000, inEffect: {left: '0', opacity: 'show'}});
};
