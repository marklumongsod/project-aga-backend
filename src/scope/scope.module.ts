import { Global, Module } from '@nestjs/common';
import { AreaScopeService } from './area-scope.service';

@Global()
@Module({ providers: [AreaScopeService], exports: [AreaScopeService] })
export class ScopeModule {}
