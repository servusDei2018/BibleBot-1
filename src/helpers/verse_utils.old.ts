import Reference from '../models/reference';
import Context from '../models/context';
import Version from '../models/version';
import Verse from '../models/verse';

import * as mongoose from 'mongoose';

import * as bibleGateway from '../interfaces/bible_gateway';
import * as apiBible from '../interfaces/api_bible';

import { createEmbed } from '../helpers/embed_builder';
import { getBookNames } from './name_fetcher';
import { removePunctuation } from './text_purification';

import * as bookMap from '../helpers/name_data/book_map.json';

const sources = {
    'bg': { name: 'BibleGateway', interface: bibleGateway },
    'ab': { name: 'API.Bible', interface: apiBible },
    'bh': { name: 'Bible Hub', interface: null },
    'bs': { name: 'Bible Server', interface: null }
};

interface BookSearchResult {
    name: string;
    index: number;
}

function checkSectionSupport(ref: Reference | string, version: mongoose.Document): Record<string, unknown> {
    let supportValue;
    let section;

    if (ref instanceof Reference) {
        section = ref.section();
    } else {
        const book = ref.slice(0, -1);
        
        const isOT = Object.values(bookMap.ot).includes(book);
        const isNT = Object.values(bookMap.nt).includes(book);
        const isDEU = Object.values(bookMap.deu).includes(book);
        
        section = isOT ? 'OT' : isNT ? 'NT' : isDEU ? 'DEU' : null;
    }

    switch (section) {
        case 'OT':
            supportValue = version.supportsOldTestament;
            break;
        case 'NT':
            supportValue = version.supportsNewTestament;
            break;
        case 'DEU':
            supportValue = version.supportsDeuterocanon;
            break;
    }

    let ok = false;

    if (ref instanceof Reference) {
        ok = (ref.section() == section && supportValue);
    } else {
        ok = (Object.values(bookMap[section]).includes(ref.split(' ')[0]) && !supportValue);
    }

    return {
        ok,
        section,
    };
}

export function isValidSource(source: string): boolean {
    return Object.keys(sources).includes(source.toLowerCase());
}

export function sourceHasInterface(source: string): boolean {
    return sources[source].interface !== null;
}

export function findBooksInMessage(msg: string): Array<BookSearchResult> {
    // TODO: Check message for book name by amount of tokens.
    const msgTokens = msg.split(' ');
    const books = getBookNames();
    const results: Array<BookSearchResult> = [];

    // eslint-disable-next-line prefer-const
    for (const [index, origToken] of msgTokens.entries()) {
        const token = removePunctuation(origToken);

        Object.keys(books).forEach(book => {
            if (books[book].includes(token)) {
                if (book == 'John' || book == 'Ezra') {
                    const previousToken = msgTokens[index - 1];
                    const prevTokenToNumber = Number(previousToken);
                    const boundaries = book == 'John' ? [0, 4] : [0, 3];

                    if (!isNaN(prevTokenToNumber) || prevTokenToNumber !== undefined) {
                        if (boundaries[0] < prevTokenToNumber && prevTokenToNumber < boundaries[1]) {
                            const name = book == 'Ezra' ? 'Esdras' : 'John';

                            results.push({
                                name: `${prevTokenToNumber} ${name}`,
                                index
                            });

                            return;
                        }
                    }

                    results.push({
                        name: `${book}`,
                        index
                    });
                } else if (book == 'Psalms') {
                    const nextToken = msgTokens[index + 1];
                    const nextTokenToNumber = Number(nextToken);

                    if (!isNaN(nextTokenToNumber) || nextTokenToNumber !== undefined) {
                        if (nextTokenToNumber == 151) {
                            results.push({
                                name: `${book} ${nextTokenToNumber}`,
                                index: index + 1
                            });
                        } else {
                            results.push({
                                name: `${book}`,
                                index
                            });
                        }
                    }
                } else if (book == 'Jeremiah') {
                    // TODO: Letter of Jeremiah
                    results.push({
                        name: book,
                        index
                    });
                } else if (['1 Corinthians', '2 Corinthians', '1 Thessalonians', '2 Thessalonians',
                            '1 Timothy', '2 Timothy', '1 Peter', '2 Peter'].includes(book)) {
                    const prevToken = msgTokens[index - 1];
                    const prevTokenToNumber = Number(prevToken);

                    if (!isNaN(prevTokenToNumber) || prevTokenToNumber !== undefined) {
                        if (0 < prevTokenToNumber && prevTokenToNumber < 3) {
                            results.push({
                                name: book,
                                index: index
                            });
                        }
                    }
                } else {
                    results.push({
                        name: book,
                        index
                    });
                }
            }
        });
    }

    return results;
}

export function isSurroundedByBrackets(brackets: string, result: BookSearchResult, msg: string): boolean {
    const tokens = msg.split(' ');
    const pureIndexOfResult = msg.indexOf(tokens[result.index]);

    const matches = msg.match(new RegExp('\\' + brackets[0] + '(.*?)\\' + brackets[1]));

    if (matches) {
        matches.forEach((match) => {
            match = match.trim();

            if (!(match.includes(brackets[0]) || match.includes(brackets[1]))) {  
                return msg.indexOf(match) == pureIndexOfResult;
            }
        });
    }

    return false;
}

export async function generateReference(result: BookSearchResult, msg: string, version: mongoose.Document): Promise<Reference> {
    const book = result['name'];
    let startingChapter = 0;
    let startingVerse = 0;
    let endingChapter = 0;
    let endingVerse = 0;
    
    const tokens = msg.split(' ');

    // Verify existence of data ahead of bookname, otherwise it isn't worth processing.
    if (result.index + 2 <= tokens.length) {
        const relevantToken = tokens.slice(result.index + 1)[0];
        
        if (relevantToken.includes(':')) {
            const colonQuantity = relevantToken.match(/:/g).length;

            switch (colonQuantity) {
                case 2: {
                    const span = relevantToken.split('-');
                    
                    span.forEach((pair) => {
                        const pairing = pair.split(':');
                        pairing.forEach((entry, index) => { pairing[index] = removePunctuation(entry); });

                        if (Number.isNaN(Number(pairing[0])) || Number.isNaN(Number(pairing[1]))) {
                            return null;
                        }
                        
                        if (startingChapter == 0) {
                            startingChapter = Number(pairing[0]);
                            startingVerse = Number(pairing[1]);    
                        } else {
                            endingChapter = Number(pairing[0]);
                            endingVerse = Number(pairing[1]);
                        }
                    });
                    
                    break;
                }
                case 1: {
                    const pairing = relevantToken.split(':');

                    if (Number.isNaN(Number(pairing[0]))) {
                        return null;
                    }
                    
                    startingChapter = Number(pairing[0]);
                    endingChapter = Number(pairing[0]);

                    const spanQuantity = (relevantToken.match(/-/g) || []).length;

                    const span = pairing[1].split('-');
                    span.forEach((num, index) => {
                        num = removePunctuation(num);

                        if (Number.isNaN(Number(num))) {
                            return null;
                        }

                        if (index == 0) {
                            startingVerse = Number(num);
                        } else if (index == 1) {
                            endingVerse = Number(num);
                        } else if (index > 1) {
                            return null;
                        }
                    });

                    if (endingVerse == 0 && spanQuantity == 0) {
                        endingVerse = startingVerse;
                    }

                    break;
                }
            }

            const lastToken = tokens[tokens.length - 1];
            const mentionedVersion = await Version.findOne({ abbv: lastToken }).exec();

            if (mentionedVersion) {
                version = mentionedVersion;
            }
        }
    } else {
        return null;
    }

    const isOT = Object.values(bookMap.ot).includes(book);
    const isNT = Object.values(bookMap.nt).includes(book);
    const isDEU = Object.values(bookMap.deu).includes(book);

    if (startingVerse == 0 || startingChapter == 0) {
        return null;
    }

    return new Reference(book, startingChapter, startingVerse, endingChapter, endingVerse, version, isOT, isNT, isDEU);
}

export async function processVerse(ctx: Context, version: mongoose.Document, reference: Reference | string, ignoreSectionCheck?: boolean): Promise<void> {
    if (!ignoreSectionCheck) {
        const sectionCheckResults = checkSectionSupport(reference, version);

        if (!sectionCheckResults.ok) {
            ctx.channel.send(createEmbed(null, ctx.language.getString('verseerror'), ctx.language.getString('invalidsection'), true));
            ctx.logInteraction('err', ctx.shard, ctx.id, ctx.channel, `${version.abbv} does not support ${sectionCheckResults.section}`);
            return;
        }
    }
    

    let processor = bibleGateway;

    switch (version.src) {
        case 'ab':
            processor = apiBible;
            break;
    }

    processor.getResult(reference, ctx.preferences.headings, ctx.preferences.verseNumbers, version, (err, data: Verse) => {
        if (err) {
            console.log('---');
            console.log(`${reference.toString()} - '${ctx.msg}`);
            console.log(err.message);
            console.log('---');
            return;
        }

        let isError = false;

        const title = `${data.passage()} - ${data.version().name}`;
        let text = data.text();

        if (['default', 'embed'].includes(ctx.preferences.display)) {
            if (text.length > 2048) {
                text = `${text.slice(0, -(text.length - 2044))}...`;
            }

            // I am so sorry.
            text = text.replace(/(\.*\s*<*\**\d*\**>*\.\.\.)$/g, '...');

            const embed = createEmbed(title, data.title(), text, false);

            ctx.channel.send(embed);
        } else if (ctx.preferences.display == 'code') {
            text = text.replace(/\*\*/g, '');

            if (text[0] != ' ') {
                text = ` ${text}`;
            }

            const newText = '```Dust\n' + (data.title() ? data.title() : null) + '\n\n' + text + '```';
            const response = `**${title}**\n\n${newText}`;

            if (response.length > 2000) {
                const embed = createEmbed(null, title, ctx.language.getString('passagetoolong'), true);
                ctx.channel.send(embed);

                isError = true;
            } else {
                ctx.channel.send(response);
            }
        } else if (ctx.preferences.display == 'blockquote') {
            let newText = null;

            if (data.title()) {
                newText = '> ' + data.title() + '\n> \n> ' + text;
            } else {
                newText = '> ' + text;
            }

            const response = `**${title}**\n\n${newText}`;

            if (response.length > 2000) {
                const embed = createEmbed(null, title, ctx.language.getString('passagetoolong'), true);
                ctx.channel.send(embed);

                isError = true;
            } else {
                ctx.channel.send(response);
            }
        }

        if (reference instanceof Reference && !isError) {
            ctx.logInteraction('info', ctx.shard, ctx.id, ctx.channel, `${reference.toString()} ${version.abbv}`);
        } else if (isError) {
            ctx.logInteraction('err', ctx.shard, ctx.id, ctx.channel, `${reference.toString()} ${version.abbv} - passage too long`);
        }
    });
}