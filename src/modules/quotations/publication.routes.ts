import {Router} from 'express';
import type {PublicationController} from './publication.controller.js';
export class PublicationRoutes {
  readonly router=Router();
  constructor(controller:PublicationController){
    this.router.post('/quotations/:q/revisions',controller.revision.bind(controller));
    this.router.post('/quotations/:q/versions/:v/share-review',controller.review.bind(controller));
    this.router.post('/quotations/:q/versions/:v/share',controller.share.bind(controller));
    this.router.get('/quotations/:q/versions/:v/access',controller.access.bind(controller));
    this.router.get('/quotations/:q/versions/:v/access/link',controller.link.bind(controller));
    this.router.post('/quotations/:q/versions/:v/access/revoke',controller.revoke.bind(controller));
    this.router.post('/quotations/:q/versions/:v/access/replace',controller.replace.bind(controller));
  }
}
